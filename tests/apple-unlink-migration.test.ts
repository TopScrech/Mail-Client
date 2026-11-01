import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { allowUnlinkedAppleAccounts } from '../src/lib/server/migrations';

test('Apple unlink migration preserves identities, credentials and child rows, and is repeatable', () => {
	const db = new Database(':memory:');
	try {
		db.exec(`PRAGMA foreign_keys=ON;
		CREATE TABLE users (id TEXT PRIMARY KEY, apple_sub TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE);
		CREATE TABLE passkeys (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE);
		CREATE TABLE accounts (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE);
		INSERT INTO users VALUES ('u','apple-u','Name','mail@example.com',42);
		INSERT INTO sessions VALUES ('session','u');
		INSERT INTO passkeys VALUES ('passkey','u');
		INSERT INTO accounts VALUES ('mail','u');`);
		allowUnlinkedAppleAccounts(db);
		allowUnlinkedAppleAccounts(db);
		expect(db.query('SELECT * FROM users').get()).toEqual({
			id: 'u',
			apple_sub: 'apple-u',
			name: 'Name',
			email: 'mail@example.com',
			revision: 42
		});
		for (const table of ['sessions', 'passkeys', 'accounts'])
			expect(db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
		db.exec(
			"UPDATE users SET apple_sub=NULL WHERE id='u'; INSERT INTO users VALUES ('v',NULL,'Other','other@example.com',0)"
		);
		expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
		expect(() => db.exec("INSERT INTO sessions VALUES ('bad','missing')")).toThrow();
		db.exec("DELETE FROM users WHERE id='u'");
		for (const table of ['sessions', 'passkeys', 'accounts'])
			expect(db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
	} finally {
		db.close();
	}
});

test('failed migration rolls back and restores foreign key enforcement', () => {
	const db = new Database(':memory:');
	try {
		db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, apple_sub TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE children (user_id TEXT REFERENCES users(id));
		INSERT INTO children VALUES ('missing'); PRAGMA foreign_keys=ON;`);
		expect(() => allowUnlinkedAppleAccounts(db)).toThrow();
		const columns = db.query('PRAGMA table_info(users)').all() as {
			name: string;
			notnull: number;
		}[];
		expect(columns.find((column) => column.name === 'apple_sub')?.notnull).toBe(1);
		expect(() => db.exec("INSERT INTO children VALUES ('another-missing')")).toThrow();
	} finally {
		db.close();
	}
});
