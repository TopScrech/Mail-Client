import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApiError } from './config';
import type { Snapshot } from '$lib/types';
const path = process.env.DATABASE_PATH || './data/mail-otter.sqlite';
if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
export const db = new Database(path, { create: true });
if (path !== ':memory:') chmodSync(path, 0o600);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, apple_sub TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT UNIQUE NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL, secret TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_owner ON messages(user_id, account_id);
CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limits (id TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sends (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, state TEXT NOT NULL, expires INTEGER NOT NULL);
`);
export interface User {
	id: string;
	apple_sub: string;
	name: string;
	email: string;
	revision: number;
}
export function one<T>(sql: string, ...params: (string | number)[]) {
	return db.query(sql).get(...params) as T | null;
}
export function all<T>(sql: string, ...params: (string | number)[]) {
	return db.query(sql).all(...params) as T[];
}
export function bump(userId: string) {
	db.query('UPDATE users SET revision=revision+1 WHERE id=?').run(userId);
}
export function snapshot(userId: string): Snapshot {
	return db.transaction(() => ({
		revision: one<User>('SELECT * FROM users WHERE id=?', userId)!.revision,
		accounts: all<{ data: string }>('SELECT data FROM accounts WHERE user_id=?', userId).map((x) =>
			JSON.parse(x.data)
		),
		messages: all<{ data: string }>('SELECT data FROM messages WHERE user_id=?', userId).map((x) =>
			JSON.parse(x.data)
		),
		drafts: all<{ data: string }>('SELECT data FROM drafts WHERE user_id=?', userId).map((x) =>
			JSON.parse(x.data)
		)
	}))();
}
export function challenge(id: string, kind: string, data: unknown) {
	db.query('INSERT INTO challenges VALUES (?,?,?,?)').run(
		id,
		kind,
		JSON.stringify(data),
		Date.now() + 300_000
	);
}
export function consume<T>(id: string, kind: string): T {
	const row = db
		.query('DELETE FROM challenges WHERE id=? AND kind=? RETURNING *')
		.get(id, kind) as { data: string; expires: number } | null;
	if (!row || row.expires < Date.now())
		throw new ApiError(400, 'Sign-in expired — please try again');
	return JSON.parse(row.data);
}
export function limit(id: string, maximum = 30, windowMs = 60_000) {
	db.transaction(() => {
		const now = Date.now();
		db.query('DELETE FROM rate_limits WHERE expires<?').run(now);
		const row = one<{ count: number }>('SELECT count FROM rate_limits WHERE id=?', id);
		if (row && row.count >= maximum)
			throw new ApiError(429, 'Too many requests — try again shortly');
		db.query(
			'INSERT INTO rate_limits VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET count=count+1'
		).run(id, now + windowMs);
	})();
}
export function cleanup() {
	db.query('DELETE FROM challenges WHERE expires<?').run(Date.now());
	db.query('DELETE FROM sessions WHERE expires<?').run(Date.now());
	db.query('DELETE FROM sends WHERE expires<?').run(Date.now());
}
