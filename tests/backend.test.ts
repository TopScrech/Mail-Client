import { beforeEach, describe, expect, test } from 'bun:test';
import type { RequestEvent } from '@sveltejs/kit';
process.env.DATABASE_PATH = ':memory:';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.ORIGIN = 'http://localhost:5173';
const { db, one, challenge, consume, limit, snapshot } = await import('../src/lib/server/db');
const { encrypt, decrypt, hash } = await import('../src/lib/server/crypto');
const { GET, POST, PUT, DELETE } = await import('../src/routes/api/v1/[...path]/+server');
const origin = 'http://localhost:5173';
const tokens = { alice: 'alice-session-secret', bob: 'bob-session-secret' };
function event(
	path: string,
	method = 'GET',
	input?: unknown,
	user: 'alice' | 'bob' | null = 'alice',
	headers: Record<string, string> = {}
): RequestEvent {
	const jar = new Map<string, string>();
	const requestHeaders = new Headers({ 'content-type': 'application/json', ...headers });
	if (user) requestHeaders.set('authorization', `Bearer ${tokens[user]}`);
	const url = new URL(`${origin}/api/v1/${path}`);
	return {
		request: new Request(url, {
			method,
			headers: requestHeaders,
			body: input === undefined ? undefined : JSON.stringify(input)
		}),
		url,
		params: { path: path.split('?')[0] },
		cookies: {
			get: (key: string) => jar.get(key),
			set: (key: string, value: string) => jar.set(key, value),
			delete: (key: string) => jar.delete(key)
		},
		getClientAddress: () => '127.0.0.1'
	} as unknown as RequestEvent;
}
beforeEach(() => {
	db.exec('DELETE FROM users; DELETE FROM challenges; DELETE FROM rate_limits;');
	for (const user of ['alice', 'bob'] as const) {
		db.query('INSERT INTO users (id,apple_sub,name,email) VALUES (?,?,?,?)').run(
			user,
			`apple-${user}`,
			user,
			`${user}@example.com`
		);
		db.query('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(
			`session-${user}`,
			user,
			hash(tokens[user]),
			'Test',
			new Date().toISOString(),
			Date.now() + 60_000
		);
		db.query('INSERT INTO accounts VALUES (?,?,?,?)').run(
			`account-${user}`,
			user,
			JSON.stringify({ id: `account-${user}`, name: user, email: `${user}@example.com` }),
			'encrypted'
		);
	}
});
describe('Authentication boundaries', () => {
	test('anonymous visitors cannot read sync data or register passkeys', async () => {
		expect((await GET(event('sync', 'GET', undefined, null))).status).toBe(401);
		expect((await POST(event('auth/passkey/register/options', 'POST', {}, null))).status).toBe(401);
	});
	test('new passkeys require an existing Apple-created user', async () => {
		const result = await POST(event('auth/passkey/register/options', 'POST', {}));
		expect(result.status).toBe(200);
		const body = await result.json();
		expect(body.options.user.name).toBe('alice@example.com');
		expect(body.options.authenticatorSelection.userVerification).toBe('required');
		expect(body.options.authenticatorSelection.residentKey).toBe('required');
	});
	test('invalid WebAuthn proofs cannot establish a session', async () => {
		const options = await (
			await POST(event('auth/passkey/login/options', 'POST', {}, null))
		).json();
		const result = await POST(
			event(
				'auth/passkey/login/verify',
				'POST',
				{ challengeId: options.challengeId, response: { id: 'unknown', response: {} } },
				null
			)
		);
		expect(result.status).toBe(401);
		expect(one<{ count: number }>('SELECT count(*) as count FROM sessions')?.count).toBe(2);
	});
	test('cross-origin requests are rejected even with valid session credentials', async () => {
		const result = await POST(
			event('auth/logout', 'POST', {}, 'alice', { origin: 'https://evil.example' })
		);
		expect(result.status).toBe(403);
		expect((await GET(event('me'))).status).toBe(200);
	});
	test('challenges are single-use, kind-bound, and expire', () => {
		challenge('a', 'apple', { nonce: '123' });
		expect(() => consume('a', 'register')).toThrow();
		expect(consume<{ nonce: string }>('a', 'apple')).toEqual({ nonce: '123' });
		expect(() => consume('a', 'apple')).toThrow();
		challenge('b', 'login', {});
		db.query('UPDATE challenges SET expires=0 WHERE id=?').run('b');
		expect(() => consume('b', 'login')).toThrow();
	});
	test('rate limits stop repeated attempts', () => {
		limit('key', 2);
		limit('key', 2);
		expect(() => limit('key', 2)).toThrow();
	});
	test('logout revokes server session', async () => {
		expect((await POST(event('auth/logout', 'POST', {}))).status).toBe(200);
		expect((await GET(event('me'))).status).toBe(401);
	});
});
describe('Device sync and ownership', () => {
	const draft = {
		id: 'draft-1',
		accountId: 'account-alice',
		to: 'friend@example.com',
		subject: 'Hello',
		text: 'First version',
		updatedAt: ''
	};
	test('snapshots contain only the authenticated user’s accounts', async () => {
		const result = await (await GET(event('sync'))).json();
		expect(result.accounts.map((x: { id: string }) => x.id)).toEqual(['account-alice']);
		expect(result.accounts[0].secret).toBeUndefined();
		expect((await GET(event(`sync?since=${result.revision}`))).status).toBe(204);
	});
	test('a saved draft is visible to another session for the same user', async () => {
		const saved = await PUT(event('drafts', 'PUT', { draft }));
		expect(saved.status).toBe(200);
		const result = await (await GET(event('sync'))).json();
		expect(result.drafts[0].text).toBe('First version');
		expect((await (await GET(event('sync', 'GET', undefined, 'bob'))).json()).drafts).toHaveLength(
			0
		);
	});
	test('stale writes cannot overwrite newer drafts even after polling', async () => {
		const first = await (await PUT(event('drafts', 'PUT', { draft }))).json();
		const version = first.drafts[0];
		await Bun.sleep(2);
		expect(
			(await PUT(event('drafts', 'PUT', { draft: { ...version, text: 'Newer edit' } }))).status
		).toBe(200);
		const stale = await PUT(event('drafts', 'PUT', { draft: { ...version, text: 'Stale edit' } }));
		expect(stale.status).toBe(409);
		expect(snapshot('alice').drafts[0].text).toBe('Newer edit');
	});
	test('deleting on another device prevents silent draft resurrection', async () => {
		const first = await (await PUT(event('drafts', 'PUT', { draft }))).json();
		await DELETE(event('drafts/draft-1', 'DELETE'));
		expect((await PUT(event('drafts', 'PUT', { draft: first.drafts[0] }))).status).toBe(409);
	});
	test('users cannot overwrite each other’s draft IDs or use foreign mail accounts', async () => {
		await PUT(event('drafts', 'PUT', { draft }));
		expect(
			(await PUT(event('drafts', 'PUT', { draft: { ...draft, accountId: 'account-bob' } }, 'bob')))
				.status
		).toBe(404);
		expect(
			(
				await PUT(
					event('drafts', 'PUT', { draft: { ...draft, id: 'new', accountId: 'account-bob' } })
				)
			).status
		).toBe(400);
	});
	test('disconnecting removes only owned account, messages, and associated drafts', async () => {
		await PUT(event('drafts', 'PUT', { draft }));
		await DELETE(event('accounts/account-bob', 'DELETE'));
		expect(snapshot('bob').accounts).toHaveLength(1);
		await DELETE(event('accounts/account-alice', 'DELETE'));
		expect(snapshot('alice').accounts).toHaveLength(0);
		expect(snapshot('alice').drafts).toHaveLength(0);
	});
	test('users cannot revoke another user’s session', async () => {
		await DELETE(event('sessions/session-bob', 'DELETE'));
		expect((await GET(event('me', 'GET', undefined, 'bob'))).status).toBe(200);
	});
});
describe('Credential storage and input limits', () => {
	test('credential encryption authenticates ciphertext and account context', () => {
		const ciphertext = encrypt('mail password', 'alice:mail');
		expect(ciphertext).not.toContain('mail password');
		expect(decrypt(ciphertext, 'alice:mail')).toBe('mail password');
		expect(() => decrypt(ciphertext, 'bob:mail')).toThrow();
		const parts = ciphertext.split('.');
		parts[2] = Buffer.from('tampered').toString('base64url');
		expect(() => decrypt(parts.join('.'), 'alice:mail')).toThrow();
	});
	test('missing encryption keys fail closed', () => {
		const key = process.env.ENCRYPTION_KEY;
		delete process.env.ENCRYPTION_KEY;
		expect(() => encrypt('secret', 'context')).toThrow();
		process.env.ENCRYPTION_KEY = key;
	});
	test('unapproved mail hosts are rejected before connecting', async () => {
		const result = await POST(
			event('accounts', 'POST', {
				name: 'Private',
				email: 'alice@example.com',
				imapHost: '127.0.0.1',
				smtpHost: 'localhost',
				smtpPort: 465,
				password: 'secret'
			})
		);
		expect(result.status).toBe(400);
		expect((await result.json()).error).toContain('not enabled');
	});
	test('oversized streamed JSON is rejected', async () => {
		const result = await POST(
			event('auth/passkey/login/options', 'POST', { padding: 'x'.repeat(1024 * 1024 + 1) }, null)
		);
		expect(result.status).toBe(413);
	});
	test('Apple callback rejects unsolicited or replayed states', async () => {
		const request = event('auth/apple/callback', 'POST', undefined, null);
		request.request = new Request(`${origin}/api/v1/auth/apple/callback`, {
			method: 'POST',
			body: new URLSearchParams({ state: 'untrusted', code: 'fake' })
		});
		const response = await POST(request);
		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toContain('authError=');
		expect(one<{ count: number }>('SELECT count(*) as count FROM users')?.count).toBe(2);
	});
});

describe('Delivery idempotency', () => {
	test('a confirmed retry returns success without reconnecting to SMTP', async () => {
		const { send } = await import('../src/lib/server/mail');
		db.query('INSERT INTO sends VALUES (?,?,?,?)').run(
			'already-sent',
			'alice',
			'sent',
			Date.now() + 60000
		);
		const draft = {
			id: 'a',
			accountId: 'account-alice',
			to: 'friend@example.com',
			subject: 'Hello',
			text: 'Body',
			updatedAt: ''
		};
		expect(await send('alice', draft, [], 'already-sent')).toEqual({ ok: true });
		db.query('INSERT INTO sends VALUES (?,?,?,?)').run(
			'uncertain-send',
			'alice',
			'pending',
			Date.now() + 60000
		);
		await expect(send('alice', draft, [], 'uncertain-send')).rejects.toThrow('uncertain');
	});
});
