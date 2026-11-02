import { beforeEach, describe, expect, test, spyOn } from 'bun:test';
import type { RequestEvent } from '@sveltejs/kit';
process.env.DATABASE_PATH = ':memory:';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.ORIGIN = 'http://localhost:5173';
const { db, one, challenge, consume, limit, snapshot } = await import('../src/lib/server/db');
const { encrypt, decrypt, hash } = await import('../src/lib/server/crypto');
const { GET, POST, PUT, PATCH, DELETE } = await import('../src/routes/api/v1/[...path]/+server');
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

describe('Live device updates', () => {
	const decode = (value?: Uint8Array) => new TextDecoder().decode(value);

	test('requires authentication and sends the current revision immediately', async () => {
		expect((await GET(event('events', 'GET', undefined, null))).status).toBe(401);
		const response = await GET(event('events'));
		expect(response.headers.get('content-type')).toBe('text/event-stream');
		expect(response.headers.get('x-accel-buffering')).toBe('no');
		const reader = response.body!.getReader();
		expect(decode((await reader.read()).value)).toContain(`data: ${snapshot('alice').revision}`);
		await reader.cancel();
	});

	test('delivers committed draft changes to the owner without leaking another user’s changes', async () => {
		const response = await GET(event('events'));
		const reader = response.body!.getReader();
		await reader.read();
		const { bump } = await import('../src/lib/server/db');
		bump('bob');
		await Promise.resolve();
		const update = reader.read();
		const draft = {
			id: 'live-draft',
			accountId: 'account-alice',
			to: '',
			subject: 'Live',
			text: 'Body',
			updatedAt: ''
		};
		await PUT(event('drafts', 'PUT', { draft }));
		const chunk = decode((await update).value);
		expect(chunk).toBe(`event: revision\ndata: ${snapshot('alice').revision}\n\n`);
		expect(snapshot('alice').drafts[0].subject).toBe('Live');
		await reader.cancel();
	});

	test('reconnecting after missed writes announces the latest revision', async () => {
		const first = (await GET(event('events'))).body!.getReader();
		await first.read();
		await first.cancel();
		const { bump } = await import('../src/lib/server/db');
		bump('alice');
		bump('alice');
		await Promise.resolve();
		const reader = (await GET(event('events'))).body!.getReader();
		expect(decode((await reader.read()).value)).toContain(`data: ${snapshot('alice').revision}`);
		await reader.cancel();
	});

	test('logout and session revocation close existing streams', async () => {
		for (const path of ['auth/logout', 'sessions/session-alice']) {
			const reader = (await GET(event('events'))).body!.getReader();
			await reader.read();
			if (path === 'auth/logout') await POST(event(path, 'POST', {}));
			else await DELETE(event(path, 'DELETE'));
			expect((await reader.read()).done).toBe(true);
			// Restore the fixture session for the second revocation path
			if (path === 'auth/logout')
				db.query('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(
					'session-alice',
					'alice',
					hash(tokens.alice),
					'Test',
					'',
					Date.now() + 60_000
				);
		}
	});

	test('expired sessions cannot receive another revision and aborted requests release their slot', async () => {
		const controller = new AbortController();
		const request = event('events');
		request.request = new Request(request.request, { signal: controller.signal });
		const reader = (await GET(request)).body!.getReader();
		await reader.read();
		controller.abort();
		expect((await reader.read()).done).toBe(true);
		const next = (await GET(event('events'))).body!.getReader();
		await next.read();
		db.query('UPDATE sessions SET expires=0 WHERE id=?').run('session-alice');
		const { bump } = await import('../src/lib/server/db');
		bump('alice');
		expect((await next.read()).done).toBe(true);
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

const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = await import('jose');
const { useAppleKeys } = await import('../src/lib/server/auth');
const { publicKey, privateKey } = await generateKeyPair('RS256');
useAppleKeys(createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'RS256' }] }));
describe('Native Sign in with Apple', () => {
	const identity = (claims: Record<string, unknown>, audience = 'dev.topscrech.Mail-Otter') =>
		new SignJWT(claims)
			.setProtectedHeader({ alg: 'RS256' })
			.setIssuer('https://appleid.apple.com')
			.setAudience(audience)
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(privateKey);
	const options = async () =>
		(await (await POST(event('auth/apple/native/options', 'POST', {}, null))).json()) as {
			challengeId: string;
			nonce: string;
		};
	test('signs in the existing user linked to the Apple identity', async () => {
		const { challengeId, nonce } = await options();
		const identityToken = await identity({ sub: 'apple-alice', nonce });
		const response = await POST(
			event('auth/apple/native', 'POST', { challengeId, identityToken }, null)
		);
		expect(response.status).toBe(200);
		const session = await response.json();
		expect(session.token).toBeString();
		const me = await (
			await GET(event('me', 'GET', undefined, null, { authorization: `Bearer ${session.token}` }))
		).json();
		expect(me.id).toBe('alice');
		expect(me.appleUserId).toBe('apple-alice');
	});
	test('creates a user for a new Apple identity', async () => {
		const { challengeId, nonce } = await options();
		const identityToken = await identity({ sub: 'apple-carol', nonce, email: 'c@example.com' });
		const response = await POST(
			event('auth/apple/native', 'POST', { challengeId, identityToken, name: 'Carol' }, null)
		);
		expect(response.status).toBe(200);
		expect(
			one<{ name: string }>("SELECT name FROM users WHERE apple_sub='apple-carol'")?.name
		).toBe('Carol');
	});
	test('rejects mismatched nonces, other audiences, and replayed challenges', async () => {
		const first = await options();
		const wrongNonce = await identity({ sub: 'apple-alice', nonce: 'other' });
		expect(
			(
				await POST(
					event(
						'auth/apple/native',
						'POST',
						{ challengeId: first.challengeId, identityToken: wrongNonce },
						null
					)
				)
			).status
		).toBe(401);
		expect(
			(
				await POST(
					event(
						'auth/apple/native',
						'POST',
						{
							challengeId: first.challengeId,
							identityToken: await identity({ sub: 'apple-alice', nonce: first.nonce })
						},
						null
					)
				)
			).status
		).toBe(400);
		const second = await options();
		const otherApp = await identity({ sub: 'apple-alice', nonce: second.nonce }, 'com.example');
		expect(
			(
				await POST(
					event(
						'auth/apple/native',
						'POST',
						{ challengeId: second.challengeId, identityToken: otherApp },
						null
					)
				)
			).status
		).toBe(401);
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

describe('Account labels', () => {
	test('renames sync and preserve other account fields', async () => {
		const before = snapshot('alice');
		const response = await PATCH(
			event('accounts/account-alice', 'PATCH', { name: '  Personal  ' })
		);
		expect(response.status).toBe(200);
		const after = await response.json();
		expect(after.accounts[0].name).toBe('Personal');
		expect(after.accounts[0].email).toBe('alice@example.com');
		expect(after.revision).toBeGreaterThan(before.revision);
	});
	test('rejects invalid labels and accounts owned by another user', async () => {
		for (const name of ['', '   ', 'a'.repeat(101), 123]) {
			expect((await PATCH(event('accounts/account-alice', 'PATCH', { name }))).status).toBe(400);
		}
		expect((await PATCH(event('accounts/account-bob', 'PATCH', { name: 'Changed' }))).status).toBe(
			404
		);
		expect(snapshot('bob').accounts[0].name).toBe('bob');
	});
	test('sets and clears account colors without changing labels', async () => {
		const name = snapshot('alice').accounts[0].name;
		const set = await PATCH(event('accounts/account-alice', 'PATCH', { color: 'teal' }));
		expect(set.status).toBe(200);
		const after = await set.json();
		expect(after.accounts[0].color).toBe('teal');
		expect(after.accounts[0].name).toBe(name);
		const both = await PATCH(
			event('accounts/account-alice', 'PATCH', { name: 'Work', color: 'purple' })
		);
		expect((await both.json()).accounts[0]).toMatchObject({ name: 'Work', color: 'purple' });
		const cleared = await PATCH(event('accounts/account-alice', 'PATCH', { color: null }));
		expect((await cleared.json()).accounts[0].color).toBeNull();
	});
	test('rejects unsupported colors and empty updates', async () => {
		for (const color of ['magenta', '#ff0000', 1, '']) {
			expect((await PATCH(event('accounts/account-alice', 'PATCH', { color }))).status).toBe(400);
		}
		expect((await PATCH(event('accounts/account-alice', 'PATCH', {}))).status).toBe(400);
		expect((await PATCH(event('accounts/account-bob', 'PATCH', { color: 'red' }))).status).toBe(
			404
		);
	});
});

describe('Mailbox OAuth', () => {
	test('requires a workspace session before connecting', async () => {
		expect((await GET(event('mail/oauth/google/start', 'GET', undefined, null))).status).toBe(303);
		expect(one('SELECT id FROM challenges')).toBeNull();
	});
	test('uses provider authorization with PKCE and rejects state mismatch', async () => {
		process.env.GOOGLE_CLIENT_ID = 'test-google';
		process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
		const start = event('mail/oauth/google/start');
		const response = await GET(start);
		const location = new URL(response.headers.get('location')!);
		expect(location.origin).toBe('https://accounts.google.com');
		expect(location.searchParams.get('code_challenge_method')).toBe('S256');
		expect(location.searchParams.get('access_type')).toBe('offline');
		expect(location.searchParams.get('scope')).toContain('https://mail.google.com/');
		const callback = event(`mail/oauth/google/callback?state=wrong&code=fake`);
		callback.cookies = start.cookies;
		const rejected = await GET(callback);
		expect(rejected.headers.get('location')).toContain('mailError=');
		expect(snapshot('alice').accounts).toHaveLength(1);
	});
	test('rejects callbacks from a different workspace session and consumes state', async () => {
		process.env.MICROSOFT_CLIENT_ID = 'test-microsoft';
		process.env.MICROSOFT_CLIENT_SECRET = 'test-secret';
		const start = event('mail/oauth/microsoft/start');
		const response = await GET(start);
		const location = new URL(response.headers.get('location')!);
		expect(location.origin).toBe('https://login.microsoftonline.com');
		expect(location.searchParams.get('scope')).toContain('SMTP.Send');
		const callback = event(
			`mail/oauth/microsoft/callback?state=${location.searchParams.get('state')}&code=fake`,
			'GET',
			undefined,
			'bob'
		);
		callback.cookies = start.cookies;
		const rejected = await GET(callback);
		expect(decodeURIComponent(rejected.headers.get('location')!)).toContain('another session');
		expect(one('SELECT id FROM challenges')).toBeNull();
	});
	test('starts native mail OAuth from a single-use ticket', async () => {
		process.env.GOOGLE_CLIENT_ID = 'test-google';
		process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
		const issued = await POST(event('mail/oauth/google/native', 'POST', {}));
		expect(issued.status).toBe(200);
		const url = new URL((await issued.json()).url);
		expect(url.pathname).toBe('/api/v1/mail/oauth/google/start');
		const start = event(`mail/oauth/google/start${url.search}`, 'GET', undefined, null);
		const response = await GET(start);
		expect(new URL(response.headers.get('location')!).origin).toBe('https://accounts.google.com');
		expect(start.cookies.get('mail_oauth_native')).toBe('1');
		const reused = await GET(event(`mail/oauth/google/start${url.search}`, 'GET', undefined, null));
		expect(reused.headers.get('location')).toStartWith('mailotter://mail-oauth?error=');
	});
	test('rejects native tickets for another provider', async () => {
		process.env.GOOGLE_CLIENT_ID = 'test-google';
		process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
		process.env.MICROSOFT_CLIENT_ID = 'test-microsoft';
		process.env.MICROSOFT_CLIENT_SECRET = 'test-secret';
		const issued = await POST(event('mail/oauth/google/native', 'POST', {}));
		const url = new URL((await issued.json()).url);
		const response = await GET(
			event(`mail/oauth/microsoft/start${url.search}`, 'GET', undefined, null)
		);
		expect(decodeURIComponent(response.headers.get('location')!)).toContain('another provider');
	});
	test('returns native callback errors to the app', async () => {
		process.env.GOOGLE_CLIENT_ID = 'test-google';
		process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
		const issued = await POST(event('mail/oauth/google/native', 'POST', {}));
		const url = new URL((await issued.json()).url);
		const start = event(`mail/oauth/google/start${url.search}`, 'GET', undefined, null);
		const location = new URL((await GET(start)).headers.get('location')!);
		const callback = event(
			`mail/oauth/google/callback?state=${location.searchParams.get('state')}&error=access_denied`,
			'GET',
			undefined,
			null
		);
		callback.cookies = start.cookies;
		const rejected = await GET(callback);
		expect(rejected.headers.get('location')).toStartWith('mailotter://mail-oauth?error=');
		expect(start.cookies.get('mail_oauth_native')).toBeUndefined();
	});
	test('only the starting session can redeem native mail credentials', async () => {
		const { storeNativeResult } = await import('../src/lib/server/mail-oauth');
		const aliceSession = one<{ id: string }>(
			'SELECT id FROM sessions WHERE token_hash=?',
			hash(tokens.alice)
		)!.id;
		const code = storeNativeResult(aliceSession, 'alice@gmail.com', {
			username: 'alice@gmail.com',
			oauth: { provider: 'google', accessToken: 'a', refreshToken: 'r', expiresAt: 0 }
		});
		const response = await POST(event('mail/oauth/native/complete', 'POST', { code }, 'bob'));
		expect(response.status).toBe(403);
		expect(one('SELECT id FROM challenges')).toBeNull();
	});
	test('keeps unexpired tokens without contacting provider', async () => {
		const { refreshOAuth } = await import('../src/lib/server/mail-oauth');
		const tokens = {
			provider: 'google' as const,
			accessToken: 'access',
			refreshToken: 'refresh',
			expiresAt: Date.now() + 3600000
		};
		expect(await refreshOAuth(tokens)).toBe(tokens);
	});
	test('preparing IDLE listeners keeps unchanged OAuth credentials stable', async () => {
		const data = { ...snapshot('alice').accounts[0], imapHost: 'imap.gmail.com' };
		const secret = encrypt(
			JSON.stringify({
				username: data.email,
				oauth: {
					provider: 'google',
					accessToken: 'access',
					refreshToken: 'refresh',
					expiresAt: Date.now() + 3600_000
				}
			}),
			'alice:account-alice'
		);
		db.query('UPDATE accounts SET data=?,secret=? WHERE id=?').run(
			JSON.stringify(data),
			secret,
			data.id
		);
		const { idleClient } = await import('../src/lib/server/mail');
		const first = await idleClient('alice', data.id);
		const second = await idleClient('alice', data.id);
		expect(one<{ secret: string }>('SELECT secret FROM accounts WHERE id=?', data.id)!.secret).toBe(
			secret
		);
		first.close();
		second.close();
	});
});

test('OAuth renewal rotates refresh tokens and reports revoked access safely', async () => {
	const { refreshOAuth } = await import('../src/lib/server/mail-oauth');
	const originalFetch = globalThis.fetch;
	const tokens = {
		provider: 'google' as const,
		accessToken: 'old-access',
		refreshToken: 'old-refresh',
		expiresAt: 0
	};
	try {
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			expect(String(init?.body)).toContain('grant_type=refresh_token');
			expect(String(init?.body)).toContain('refresh_token=old-refresh');
			return Response.json({
				access_token: 'new-access',
				refresh_token: 'new-refresh',
				expires_in: 3600,
				token_type: 'Bearer'
			});
		}) as typeof fetch;
		const updated = await refreshOAuth(tokens);
		expect(updated.accessToken).toBe('new-access');
		expect(updated.refreshToken).toBe('new-refresh');
		expect(updated.expiresAt).toBeGreaterThan(Date.now());
		globalThis.fetch = (async () =>
			Response.json({ error: 'invalid_grant' }, { status: 400 })) as unknown as typeof fetch;
		expect(refreshOAuth(tokens)).rejects.toThrow('connect the account again');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

describe('Mail account reconnection', () => {
	const input = {
		name: 'Changed label',
		email: 'alice@example.com',
		password: 'new-password',
		imapHost: 'imap.mail.me.com',
		smtpHost: 'smtp.mail.me.com',
		smtpPort: 587
	};
	function prepare(oauth = false, reconnectRequired = true) {
		const data = {
			...snapshot('alice').accounts[0],
			...input,
			name: 'Personal',
			error: reconnectRequired ? 'Authentication failed' : null,
			reconnectRequired
		};
		delete (data as Record<string, unknown>).password;
		db.query('UPDATE accounts SET data=?, secret=? WHERE id=?').run(
			JSON.stringify(data),
			encrypt(
				JSON.stringify(
					oauth
						? {
								username: 'alice@example.com',
								oauth: {
									provider: 'google',
									accessToken: 'expired',
									refreshToken: 'revoked',
									expiresAt: 0
								}
							}
						: { username: 'custom-login', password: 'old-password' }
				),
				'alice:account-alice'
			),
			'account-alice'
		);
	}
	test('rejected OAuth refresh marks the account for reconnect and preserves cached mail', async () => {
		prepare(true, false);
		const originalFetch = globalThis.fetch;
		const revision = snapshot('alice').revision;
		try {
			globalThis.fetch = (async () =>
				Response.json({ error: 'invalid_grant' }, { status: 400 })) as unknown as typeof fetch;
			const result = await POST(event('mail/sync', 'POST', {}));
			const body = await result.json();
			expect(body.accounts[0].reconnectRequired).toBe(true);
			expect(body.accounts[0].error).toContain('reconnect');
			expect(body.revision).toBeGreaterThan(revision);
			expect(body.errors[0]).toContain('connect the account again');
			expect(snapshot('bob').accounts[0].reconnectRequired).toBeUndefined();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
	test('provider outages do not request new credentials', async () => {
		prepare(true);
		const data = snapshot('alice').accounts[0];
		data.reconnectRequired = false;
		data.error = null;
		db.query('UPDATE accounts SET data=? WHERE id=?').run(JSON.stringify(data), data.id);
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = (async () =>
				Response.json({ error: 'server_error' }, { status: 503 })) as unknown as typeof fetch;
			const result = await POST(event('mail/sync', 'POST', {}));
			const body = await result.json();
			expect(body.accounts[0].reconnectRequired).toBe(false);
			expect(body.errors[0]).toContain('try again shortly');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
	test('IMAP login rejection produces a persistent reconnect suggestion', async () => {
		prepare(false, false);
		const { ImapFlow } = await import('imapflow');
		const login = spyOn(ImapFlow.prototype, 'connect').mockRejectedValue(
			Object.assign(new Error('Invalid login'), { authenticationFailed: true })
		);
		const logout = spyOn(ImapFlow.prototype, 'logout').mockResolvedValue(undefined);
		try {
			const result = await POST(event('mail/sync', 'POST', {}));
			const body = await result.json();
			expect(body.accounts[0].reconnectRequired).toBe(true);
			expect(body.accounts[0].error).toContain('reconnect');
		} finally {
			login.mockRestore();
			logout.mockRestore();
		}
	});
	test('reconnecting replaces verified credentials in place and keeps messages and drafts', async () => {
		prepare();
		db.query('INSERT INTO messages VALUES (?,?,?,?)').run(
			'cached',
			'alice',
			'account-alice',
			JSON.stringify({ id: 'cached', accountId: 'account-alice' })
		);
		db.query('INSERT INTO drafts VALUES (?,?,?)').run(
			'saved',
			'alice',
			JSON.stringify({ id: 'saved', accountId: 'account-alice' })
		);
		const { ImapFlow } = await import('imapflow');
		const { default: nodemailer } = await import('nodemailer');
		const login = spyOn(ImapFlow.prototype, 'connect').mockResolvedValue(undefined);
		const logout = spyOn(ImapFlow.prototype, 'logout').mockResolvedValue(undefined);
		const transport = spyOn(nodemailer, 'createTransport').mockReturnValue({
			verify: async () => true,
			close() {}
		} as never);
		try {
			const result = await POST(event('accounts/account-alice/reconnect', 'POST', input));
			expect(result.status).toBe(200);
			const after = snapshot('alice');
			expect(after.accounts).toHaveLength(1);
			expect(after.accounts[0].id).toBe('account-alice');
			expect(after.accounts[0].name).toBe('Personal');
			expect(after.accounts[0].reconnectRequired).toBe(false);
			expect(after.accounts[0].error).toBeNull();
			expect(after.messages[0].id).toBe('cached');
			expect(after.drafts[0].id).toBe('saved');
			const row = one<{ secret: string }>(
				'SELECT secret FROM accounts WHERE id=?',
				'account-alice'
			)!;
			expect(JSON.parse(decrypt(row.secret, 'alice:account-alice'))).toEqual({
				username: 'custom-login',
				password: 'new-password'
			});
		} finally {
			login.mockRestore();
			logout.mockRestore();
			transport.mockRestore();
		}
	});
	test('SMTP authentication rejection suggests reconnect and allows a safe send retry', async () => {
		prepare(false, false);
		const { default: nodemailer } = await import('nodemailer');
		const transport = spyOn(nodemailer, 'createTransport').mockReturnValue({
			sendMail: async () => {
				throw Object.assign(new Error('Login denied'), { code: 'EAUTH' });
			},
			close() {}
		} as never);
		try {
			const { send } = await import('../src/lib/server/mail');
			await expect(
				send(
					'alice',
					{
						id: 'draft',
						accountId: 'account-alice',
						to: 'friend@example.com',
						subject: 'Hello',
						text: 'Message',
						updatedAt: ''
					},
					[],
					'rejected-auth-send'
				)
			).rejects.toThrow('connect the account again');
			expect(snapshot('alice').accounts[0].reconnectRequired).toBe(true);
			expect(one('SELECT id FROM sends WHERE id=?', 'rejected-auth-send')).toBeNull();
		} finally {
			transport.mockRestore();
		}
	});
	test('failed reconnect leaves previous credentials and error state intact', async () => {
		prepare();
		const before = one<{ secret: string }>(
			'SELECT secret FROM accounts WHERE id=?',
			'account-alice'
		)!;
		const { ImapFlow } = await import('imapflow');
		const { default: nodemailer } = await import('nodemailer');
		const login = spyOn(ImapFlow.prototype, 'connect').mockRejectedValue(
			Object.assign(new Error('Invalid login'), { authenticationFailed: true })
		);
		const logout = spyOn(ImapFlow.prototype, 'logout').mockResolvedValue(undefined);
		const transport = spyOn(nodemailer, 'createTransport').mockReturnValue({ close() {} } as never);
		try {
			expect((await POST(event('accounts/account-alice/reconnect', 'POST', input))).status).toBe(
				422
			);
			expect(snapshot('alice').accounts[0].reconnectRequired).toBe(true);
			expect(
				one<{ secret: string }>('SELECT secret FROM accounts WHERE id=?', 'account-alice')!.secret
			).toBe(before.secret);
		} finally {
			login.mockRestore();
			logout.mockRestore();
			transport.mockRestore();
		}
	});
	test('reconnect rejects other owners and changing the account identity', async () => {
		prepare();
		expect((await POST(event('accounts/account-bob/reconnect', 'POST', input))).status).toBe(404);
		expect(
			(
				await POST(
					event('accounts/account-alice/reconnect', 'POST', {
						...input,
						email: 'other@example.com'
					})
				)
			).status
		).toBe(400);
		expect(snapshot('alice').accounts[0].reconnectRequired).toBe(true);
	});
});

describe('Message move reconciliation', () => {
	async function mockMove(failure = false, mapsUID = true) {
		const { ImapFlow } = await import('imapflow');
		const data = {
			...snapshot('alice').accounts[0],
			imapHost: 'imap.mail.me.com',
			smtpHost: 'smtp.mail.me.com',
			smtpPort: 587
		};
		db.query('UPDATE accounts SET data=?, secret=? WHERE id=?').run(
			JSON.stringify(data),
			encrypt(
				JSON.stringify({ username: data.email, password: 'password' }),
				'alice:account-alice'
			),
			data.id
		);
		db.query('INSERT INTO messages VALUES (?,?,?,?)').run(
			'moving',
			'alice',
			data.id,
			JSON.stringify({
				id: 'moving',
				accountId: data.id,
				path: 'INBOX',
				folder: 'inbox',
				uid: 7,
				uidValidity: '1'
			})
		);
		const mocks = [
			spyOn(ImapFlow.prototype, 'connect').mockResolvedValue(undefined),
			spyOn(ImapFlow.prototype, 'logout').mockResolvedValue(undefined),
			spyOn(ImapFlow.prototype, 'list').mockResolvedValue([
				{ path: 'Trash', specialUse: '\\Trash' }
			] as never),
			spyOn(ImapFlow.prototype, 'getMailboxLock').mockImplementation(async function (
				this: InstanceType<typeof ImapFlow>
			) {
				this.mailbox = { uidValidity: 1n } as never;
				return { release() {} } as never;
			}),
			spyOn(ImapFlow.prototype, 'messageMove').mockImplementation(async () => {
				if (failure) throw new Error('Provider unavailable');
				return {
					path: 'INBOX',
					destination: 'Trash',
					uidValidity: 2n,
					uidMap: mapsUID ? new Map([[7, 42]]) : undefined
				};
			})
		];
		return () => mocks.forEach((mock) => mock.mockRestore());
	}
	test('move is saved immediately even while a slow sync holds the mail lock', async () => {
		const restore = await mockMove();
		const { serialized, processPendingMoves } = await import('../src/lib/server/mail');
		let release!: () => void;
		const slowSync = serialized(
			'alice',
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		await Promise.resolve();
		const revision = snapshot('alice').revision;
		try {
			const response = await PATCH(event('messages', 'PATCH', { id: 'moving', folder: 'trash' }));
			expect(response.status).toBe(202);
			const body = await response.json();
			expect(body.pending).toBe(true);
			expect(body.revision).toBeGreaterThan(revision);
			expect(body.messages).toEqual([]);
			// A refreshed page gets the persisted pending state while the provider is still blocked
			const refreshed = await (await GET(event('sync'))).json();
			expect(refreshed.messages).toEqual([]);
			expect(one('SELECT message_id FROM pending_moves WHERE user_id=?', 'alice')).not.toBeNull();
			expect(one('SELECT id FROM messages WHERE id=?', 'moving')).not.toBeNull();
		} finally {
			release();
			await slowSync;
			await processPendingMoves('alice');
			restore();
		}
		expect(snapshot('alice').messages[0].folder).toBe('trash');
		expect(snapshot('alice').messages[0].id).toBe('account-alice:Trash:2:42');
		expect(one('SELECT message_id FROM pending_moves')).toBeNull();
	});
	test('failed provider move keeps the cached message available for rollback', async () => {
		const restore = await mockMove(true);
		const revision = snapshot('alice').revision;
		try {
			const response = await PATCH(event('messages', 'PATCH', { id: 'moving', folder: 'trash' }));
			expect(response.status).toBe(202);
			const { processPendingMoves } = await import('../src/lib/server/mail');
			await processPendingMoves('alice');
			expect(snapshot('alice').revision).toBeGreaterThan(revision);
			expect(snapshot('alice').accounts[0].error).toContain('restored');
			expect(snapshot('alice').accounts[0].actionError).toContain('Provider unavailable');
			expect(one('SELECT message_id FROM pending_moves')).toBeNull();
			expect(snapshot('alice').messages[0].id).toBe('moving');
			expect(snapshot('alice').messages[0].folder).toBe('inbox');
		} finally {
			restore();
		}
	});
	test('sync resumes a persisted move without relying on the original request', async () => {
		const restore = await mockMove();
		const { queueMessageMove, processPendingMoves } = await import('../src/lib/server/mail');
		try {
			queueMessageMove('alice', 'moving', { folder: 'trash' });
			expect(snapshot('alice').messages).toEqual([]);
			expect(one('SELECT message_id FROM pending_moves')).not.toBeNull();
			await GET(event('sync'));
			await processPendingMoves('alice');
			expect(one('SELECT message_id FROM pending_moves')).toBeNull();
			expect(one('SELECT id FROM messages WHERE id=?', 'moving')).toBeNull();
		} finally {
			restore();
		}
	});
	for (const { failure, mapsUID } of [
		{ failure: false, mapsUID: true },
		{ failure: false, mapsUID: false },
		{ failure: true, mapsUID: true }
	]) {
		test(`restoring from Trash records a silent arrival only after a successful provider move: failure=${failure}, mapping=${mapsUID}`, async () => {
			const restore = await mockMove(failure, mapsUID);
			const { updateMessage } = await import('../src/lib/server/mail');
			db.query(
				"UPDATE messages SET data=json_set(data,'$.folder','trash','$.path','Trash') WHERE id=?"
			).run('moving');
			try {
				if (failure) {
					await expect(updateMessage('alice', 'moving', { folder: 'inbox' })).rejects.toThrow(
						'Provider unavailable'
					);
					expect(one('SELECT identity FROM push_silent_arrivals')).toBeNull();
				} else {
					await updateMessage('alice', 'moving', { folder: 'inbox' });
					const identity = one<{ identity: string }>(
						'SELECT identity FROM push_silent_arrivals WHERE account_id=?',
						'account-alice'
					)?.identity;
					if (mapsUID) {
						expect(identity).toBe('uid:2:42');
						expect(snapshot('alice').messages[0].folder).toBe('inbox');
					} else {
						expect(identity).toStartWith('message:');
					}
				}
			} finally {
				restore();
			}
		});
	}

	test('users cannot queue moves for another user’s messages', async () => {
		const restore = await mockMove();
		try {
			const response = await PATCH(
				event('messages', 'PATCH', { id: 'moving', folder: 'trash' }, 'bob')
			);
			expect(response.status).toBe(404);
			expect(one('SELECT message_id FROM pending_moves')).toBeNull();
			expect(snapshot('alice').messages[0].id).toBe('moving');
		} finally {
			restore();
		}
	});
});

describe('Permanent deletion from Trash', () => {
	async function fixture(
		options: {
			folder?: string;
			uidValidity?: bigint;
			unsupported?: boolean;
			missing?: boolean;
			failure?: boolean;
			throws?: boolean;
			rev2?: boolean;
			remains?: boolean;
		} = {}
	) {
		const { ImapFlow } = await import('imapflow');
		const data = { ...snapshot('alice').accounts[0], imapHost: 'imap.mail.me.com' };
		db.query('UPDATE accounts SET data=?,secret=? WHERE id=?').run(
			JSON.stringify(data),
			encrypt(JSON.stringify({ username: data.email, password: 'test' }), 'alice:account-alice'),
			data.id
		);
		const mail = {
			id: 'trashed',
			accountId: data.id,
			folder: options.folder || 'trash',
			path: 'Trash',
			uid: 7,
			uidValidity: '1'
		};
		db.query('INSERT INTO messages VALUES (?,?,?,?)').run(
			mail.id,
			'alice',
			data.id,
			JSON.stringify(mail)
		);
		db.query('INSERT INTO messages VALUES (?,?,?,?)').run(
			'other',
			'alice',
			data.id,
			JSON.stringify({ ...mail, id: 'other', uid: 8 })
		);
		db.query('INSERT INTO body_jobs (message_id,user_id,account_id,size) VALUES (?,?,?,0)').run(
			mail.id,
			'alice',
			data.id
		);
		let present = !options.missing;
		const connect = spyOn(ImapFlow.prototype, 'connect').mockImplementation(async function (
			this: InstanceType<typeof ImapFlow>
		) {
			if (options.rev2) this.enabled.add('IMAP4REV2');
			else if (!options.unsupported) this.capabilities.set('UIDPLUS', true);
		});
		const fetch = spyOn(ImapFlow.prototype, 'fetchOne').mockImplementation(async () =>
			present ? ({ uid: 7 } as never) : false
		);
		const remove = spyOn(ImapFlow.prototype, 'messageDelete').mockImplementation(async () => {
			if (options.throws) throw new Error('Provider unavailable');
			if (options.failure) return false;
			if (!options.remains) present = false;
			return true;
		});
		const mocks = [
			spyOn(ImapFlow.prototype, 'fetchAll').mockImplementation(
				async () =>
					[
						{ uid: 8, flags: new Set(), envelope: { subject: 'Other message' } },
						...(present
							? [{ uid: 7, flags: new Set(), envelope: { subject: 'Selected message' } }]
							: [])
					] as never
			),
			connect,
			fetch,
			remove,
			spyOn(ImapFlow.prototype, 'logout').mockResolvedValue(undefined),
			spyOn(ImapFlow.prototype, 'getMailboxLock').mockImplementation(async function (
				this: InstanceType<typeof ImapFlow>
			) {
				this.mailbox = { uidValidity: options.uidValidity ?? 1n, exists: present ? 2 : 1 } as never;
				return { release() {} } as never;
			}),
			spyOn(ImapFlow.prototype, 'list').mockResolvedValue([
				{ path: 'Trash', specialUse: '\\Trash' }
			] as never)
		];
		return { connect, fetch, remove, restore: () => mocks.forEach((mock) => mock.mockRestore()) };
	}
	const request = (input: Record<string, unknown> = {}, user: 'alice' | 'bob' = 'alice') =>
		PATCH(event('messages', 'PATCH', { id: 'trashed', permanentlyDelete: true, ...input }, user));

	test('confirmed deletion removes only the selected UID and cached body jobs, and refresh keeps it absent', async () => {
		const state = await fixture();
		try {
			const response = await request();
			expect(response.status).toBe(200);
			expect(state.remove).toHaveBeenCalledWith(7, { uid: true });
			expect(state.fetch).toHaveBeenCalledTimes(2);
			expect((await response.json()).messages.map((m: { id: string }) => m.id)).toEqual(['other']);
			expect(one('SELECT message_id FROM body_jobs WHERE message_id=?', 'trashed')).toBeNull();
			expect(
				(await (await GET(event('sync'))).json()).messages.map((m: { id: string }) => m.id)
			).toEqual(['other']);
			const reconciled = await POST(event('mail/sync', 'POST', {}));
			expect(reconciled.status).toBe(200);
			expect((await reconciled.json()).messages.map((m: { id: string }) => m.id)).toEqual([
				'other'
			]);
			expect((await request()).status).toBe(404);
		} finally {
			state.restore();
		}
	});

	test('ordinary move-to-Trash requests never permanently delete messages already in Trash', async () => {
		const state = await fixture();
		const { processPendingMoves } = await import('../src/lib/server/mail');
		try {
			expect(
				(await PATCH(event('messages', 'PATCH', { id: 'trashed', folder: 'trash' }))).status
			).toBe(202);
			await processPendingMoves('alice');
			expect(state.remove).not.toHaveBeenCalled();
			expect(one('SELECT id FROM messages WHERE id=?', 'trashed')).not.toBeNull();
		} finally {
			state.restore();
		}
	});

	const bulk = (input: Record<string, unknown>, user: 'alice' | 'bob' = 'alice') =>
		PATCH(event('messages/bulk', 'PATCH', input, user));

	test('bulk deletion expunges the selected UIDs in one provider call and skips missing IDs', async () => {
		const state = await fixture();
		try {
			const response = await bulk({ ids: ['trashed', 'gone', 'trashed'], permanentlyDelete: true });
			const result = await response.json();
			expect(response.status).toBe(200);
			expect(result.errors).toEqual([]);
			expect(state.connect).toHaveBeenCalledTimes(1);
			expect(state.remove).toHaveBeenCalledTimes(1);
			expect(state.remove).toHaveBeenCalledWith([7], { uid: true });
			expect(result.messages.map((m: { id: string }) => m.id)).toEqual(['other']);
		} finally {
			state.restore();
		}
	});

	test('bulk deletion reports provider failures and keeps cached messages', async () => {
		const state = await fixture({ remains: true });
		try {
			const result = await (await bulk({ ids: ['trashed'], permanentlyDelete: true })).json();
			expect(result.ok).toBe(false);
			expect(result.errors[0]).toContain('still in Trash');
			expect(one('SELECT id FROM messages WHERE id=?', 'trashed')).not.toBeNull();
		} finally {
			state.restore();
		}
	});

	test('bulk deletion ignores other users and rejects messages outside Trash', async () => {
		const state = await fixture({ folder: 'inbox' });
		try {
			await bulk({ ids: ['trashed'], permanentlyDelete: true }, 'bob');
			const result = await (await bulk({ ids: ['trashed'], permanentlyDelete: true })).json();
			expect(result.errors).toHaveLength(1);
			expect(state.remove).not.toHaveBeenCalled();
			expect(snapshot('alice').messages).toHaveLength(2);
		} finally {
			state.restore();
		}
	});

	test('bulk flag updates use one provider call for all UIDs', async () => {
		const state = await fixture();
		const { ImapFlow } = await import('imapflow');
		const add = spyOn(ImapFlow.prototype, 'messageFlagsAdd').mockResolvedValue(true);
		try {
			const result = await (await bulk({ ids: ['trashed', 'other'], read: true })).json();
			expect(result.errors).toEqual([]);
			expect(state.connect).toHaveBeenCalledTimes(1);
			expect(add).toHaveBeenCalledTimes(1);
			expect(add).toHaveBeenCalledWith([7, 8], ['\\Seen'], { uid: true });
			expect(result.messages.every((m: { read: boolean }) => m.read)).toBe(true);
		} finally {
			add.mockRestore();
			state.restore();
		}
	});

	test('bulk moves are hidden in one response without waiting for the provider', async () => {
		const { processPendingMoves } = await import('../src/lib/server/mail');
		const state = await fixture();
		const worker = spyOn(
			(await import('imapflow')).ImapFlow.prototype,
			'messageMove'
		).mockResolvedValue(false as never);
		try {
			const response = await bulk({ ids: ['trashed', 'other', 'gone'], folder: 'archive' });
			expect(response.status).toBe(202);
			expect((await response.json()).messages).toEqual([]);
		} finally {
			await processPendingMoves('alice').catch(() => {});
			worker.mockRestore();
			state.restore();
		}
	});

	test('bulk requests reject invalid selections and conflicting changes before connecting', async () => {
		const state = await fixture();
		try {
			for (const input of [
				{ ids: [], read: true },
				{ ids: 'trashed', read: true },
				{ ids: [1], read: true },
				{ ids: Array(1001).fill('trashed'), read: true },
				{ ids: ['trashed'] },
				{ ids: ['trashed'], folder: 'sent' },
				{ ids: ['trashed'], permanentlyDelete: false },
				{ ids: ['trashed'], permanentlyDelete: true, read: true }
			])
				expect((await bulk(input)).status).toBe(400);
			expect(state.connect).not.toHaveBeenCalled();
		} finally {
			state.restore();
		}
	});

	test('ownership, Trash membership, explicit intent and conflicting changes are checked before connecting', async () => {
		const state = await fixture({ folder: 'inbox' });
		try {
			expect((await request({}, 'bob')).status).toBe(404);
			expect((await request()).status).toBe(409);
			expect((await request({ folder: 'trash' })).status).toBe(400);
			expect((await request({ read: true })).status).toBe(400);
			expect((await request({ permanentlyDelete: false })).status).toBe(400);
			expect(state.connect).not.toHaveBeenCalled();
			expect(state.remove).not.toHaveBeenCalled();
		} finally {
			state.restore();
		}
	});

	test('mailbox identity changes never delete a recycled UID', async () => {
		const state = await fixture({ uidValidity: 2n });
		try {
			expect((await request()).status).toBe(409);
			expect(state.remove).not.toHaveBeenCalled();
			expect(one('SELECT id FROM messages WHERE id=?', 'trashed')).not.toBeNull();
		} finally {
			state.restore();
		}
	});

	test('servers without targeted expunge support cannot expunge other deleted messages', async () => {
		const state = await fixture({ unsupported: true });
		try {
			expect((await request()).status).toBe(422);
			expect(state.remove).not.toHaveBeenCalled();
			expect(snapshot('alice').messages).toHaveLength(2);
		} finally {
			state.restore();
		}
	});

	for (const options of [{ failure: true }, { remains: true }, { throws: true }]) {
		test(`provider deletion failure preserves the cached message: ${JSON.stringify(options)}`, async () => {
			const state = await fixture(options);
			try {
				const response = await request();
				expect(response.status).toBe(502);
				if ('throws' in options)
					expect((await response.json()).error).toContain('Provider unavailable');
				expect(one('SELECT id FROM messages WHERE id=?', 'trashed')).not.toBeNull();
				expect(
					one('SELECT message_id FROM body_jobs WHERE message_id=?', 'trashed')
				).not.toBeNull();
			} finally {
				state.restore();
			}
		});
	}

	test('IMAP4rev2 targeted expunge is accepted without a separate UIDPLUS advertisement', async () => {
		const state = await fixture({ rev2: true });
		try {
			expect((await request()).status).toBe(200);
			expect(state.remove).toHaveBeenCalledWith(7, { uid: true });
		} finally {
			state.restore();
		}
	});

	test('an already expunged UID removes the stale cache entry without attempting another deletion', async () => {
		const state = await fixture({ missing: true, unsupported: true });
		try {
			expect((await request()).status).toBe(200);
			expect(state.remove).not.toHaveBeenCalled();
			expect(one('SELECT id FROM messages WHERE id=?', 'trashed')).toBeNull();
		} finally {
			state.restore();
		}
	});

	test('pending moves must finish before permanent deletion', async () => {
		const state = await fixture();
		const { queueMessageMove } = await import('../src/lib/server/mail');
		try {
			queueMessageMove('alice', 'trashed', { folder: 'inbox' });
			expect((await request()).status).toBe(409);
			expect(state.remove).not.toHaveBeenCalled();
			expect(state.connect).not.toHaveBeenCalled();
		} finally {
			state.restore();
		}
	});
});

describe('Background sync error reporting', () => {
	test('provider failures appear in snapshots with the original reason and account ownership', async () => {
		const { recordSyncFailure } = await import('../src/lib/server/mail');
		const revision = snapshot('alice').revision;
		recordSyncFailure('alice', 'account-alice', new Error('Connection timed out'));
		expect(snapshot('alice').accounts[0].error).toContain('Connection timed out');
		expect(snapshot('alice').revision).toBeGreaterThan(revision);
		expect(snapshot('bob').accounts[0].error).toBeUndefined();
		const reported = snapshot('alice').revision;
		recordSyncFailure('alice', 'account-alice', new Error('Connection timed out'));
		expect(snapshot('alice').revision).toBe(reported);
		recordSyncFailure('bob', 'account-alice', new Error('Wrong owner'));
		expect(snapshot('alice').accounts[0].error).toContain('Connection timed out');
	});

	test('successful mailbox sync retains a failed deletion reason for the next app refresh', async () => {
		const { syncAccount } = await import('../src/lib/server/mail');
		const { ImapFlow } = await import('imapflow');
		const actionError =
			'A message could not be moved — Your mail server does not expose a trash folder';
		const data = {
			...snapshot('alice').accounts[0],
			imapHost: 'imap.mail.me.com',
			error: actionError,
			actionError
		};
		db.query('UPDATE accounts SET data=?,secret=? WHERE id=?').run(
			JSON.stringify(data),
			encrypt(JSON.stringify({ username: data.email, password: 'test' }), 'alice:account-alice'),
			data.id
		);
		const mocks = [
			spyOn(ImapFlow.prototype, 'connect').mockResolvedValue(undefined),
			spyOn(ImapFlow.prototype, 'logout').mockResolvedValue(undefined),
			spyOn(ImapFlow.prototype, 'list').mockResolvedValue([])
		];
		try {
			await syncAccount('alice', data.id);
			expect(snapshot('alice').accounts[0].error).toBeNull();
			expect(snapshot('alice').accounts[0].actionError).toBe(actionError);
			expect((await (await GET(event('sync'))).json()).accounts[0].actionError).toBe(actionError);
		} finally {
			mocks.forEach((mock) => mock.mockRestore());
		}
	});

	test('authentication failures retain their reconnect guidance', async () => {
		const { recordSyncFailure } = await import('../src/lib/server/mail');
		recordSyncFailure(
			'alice',
			'account-alice',
			Object.assign(new Error('Login rejected'), { authenticationFailed: true })
		);
		expect(snapshot('alice').accounts[0].reconnectRequired).toBe(true);
		recordSyncFailure('alice', 'account-alice', new Error('Connection lost'));
		expect(snapshot('alice').accounts[0].error).toContain('reconnect');
	});
});

describe('Inbox notification latency', () => {
	test('reconciliation publishes the inbox before waiting for slower folders', async () => {
		const { syncAccount } = await import('../src/lib/server/mail');
		const { ImapFlow } = await import('imapflow');
		const data = { ...snapshot('alice').accounts[0], imapHost: 'imap.mail.me.com' };
		db.query('UPDATE accounts SET data=?,secret=? WHERE id=?').run(
			JSON.stringify(data),
			encrypt(JSON.stringify({ username: data.email, password: 'test' }), 'alice:account-alice'),
			data.id
		);
		let release!: () => void;
		const opened: string[] = [];
		const mocks = [
			spyOn(ImapFlow.prototype, 'connect').mockResolvedValue(undefined),
			spyOn(ImapFlow.prototype, 'logout').mockResolvedValue(undefined),
			spyOn(ImapFlow.prototype, 'list').mockResolvedValue([
				{ path: 'Sent', specialUse: '\\Sent' },
				{ path: 'INBOX' }
			] as never),
			spyOn(ImapFlow.prototype, 'getMailboxLock').mockImplementation(async function (
				this: InstanceType<typeof ImapFlow>,
				path: string | string[]
			) {
				opened.push(String(path));
				if (path === 'Sent')
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				this.mailbox = { exists: path === 'INBOX' ? 1 : 0, uidValidity: 1n } as never;
				return { release() {} } as never;
			}),
			spyOn(ImapFlow.prototype, 'fetchAll').mockResolvedValue([
				{ uid: 7, flags: new Set(), size: 50, envelope: { subject: 'Published first' } }
			] as never),
			spyOn(ImapFlow.prototype, 'fetchOne').mockResolvedValue({
				source: Buffer.from('Content-Type: text/plain\r\n\r\nBody')
			} as never)
		];
		const job = syncAccount('alice', data.id);
		try {
			for (let attempt = 0; !release && attempt < 100; attempt++) await Bun.sleep(2);
			expect(release).toBeDefined();
			expect(opened).toEqual(['INBOX', 'Sent']);
			expect(snapshot('alice').messages[0].subject).toBe('Published first');
		} finally {
			release?.();
			await job;
			mocks.forEach((mock) => mock.mockRestore());
		}
	});

	async function fixture() {
		const { syncInbox } = await import('../src/lib/server/mail');
		const { ImapFlow } = await import('imapflow');
		const client = new ImapFlow({ host: 'unused.example', logger: false });
		client.mailbox = { exists: 1, uidValidity: 1n } as never;
		const headers = [
			{
				uid: 7,
				size: 120,
				flags: new Set<string>(),
				envelope: {
					from: [{ name: 'Friend', address: 'friend@example.com' }],
					to: [{ address: 'alice@example.com' }],
					subject: 'Arrived now',
					date: new Date('2026-10-29T10:00:00Z')
				}
			}
		];
		const mocks = [
			spyOn(client, 'connect').mockImplementation(async () => {
				throw new Error('Must reuse IDLE connection');
			}),
			spyOn(client, 'list').mockImplementation(async () => {
				throw new Error('Must not scan other folders');
			}),
			spyOn(client, 'logout').mockImplementation(async () => {
				throw new Error('Must keep IDLE connection');
			}),
			spyOn(client, 'getMailboxLock').mockResolvedValue({ release() {} } as never),
			spyOn(client, 'fetchAll').mockImplementation(async () => headers as never)
		];
		return {
			client,
			headers,
			syncInbox,
			restore: () => mocks.forEach((mock) => mock.mockRestore())
		};
	}

	test('backfills provider artwork once and preserves it through later flag syncs', async () => {
		const state = await fixture();
		const { createHash } = await import('node:crypto');
		const data = { ...snapshot('alice').accounts[0], imapHost: 'imap.gmail.com' };
		db.query('UPDATE accounts SET data=? WHERE id=?').run(JSON.stringify(data), data.id);
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><path fill="red" d="M0 0h100v100H0z"/></svg>';
		const hash = createHash('sha256').update(svg).digest('hex');
		const raw = Buffer.from(
			`From: friend@example.com\r\nAuthentication-Results: mx.google.com; dmarc=pass header.from=example.com; bimi=pass header.d=example.com header.selector=default policy.authority=pass policy.indicator-hash=${hash}\r\nBIMI-Indicator: ${Buffer.from(svg).toString('base64')}\r\n\r\n`
		);
		try {
			await state.syncInbox('alice', 'account-alice', state.client);
			const old = snapshot('alice').messages.find((message) => message.uid === 7)!;
			delete old.bimiLogo;
			db.query('UPDATE messages SET data=? WHERE id=?').run(JSON.stringify(old), old.id);
			Object.assign(state.headers[0], { headers: raw });
			await state.syncInbox('alice', 'account-alice', state.client);
			const logo = snapshot('alice').messages.find((message) => message.uid === 7)!.bimiLogo;
			expect(logo).toBeString();
			state.headers[0].flags.add('\\Seen');
			const fetches = spyOn(state.client, 'fetchAll').mockImplementation(async (_range, query) => {
				expect(query?.headers).toBeUndefined();
				return state.headers as never;
			});
			await state.syncInbox('alice', 'account-alice', state.client);
			const updated = snapshot('alice').messages.find((message) => message.uid === 7)!;
			expect(updated.bimiLogo).toBe(logo);
			expect(updated.read).toBe(true);
			fetches.mockRestore();
		} finally {
			state.restore();
		}
	});

	function bodyMocks(fetch: (...args: any[]) => Promise<any>) {
		return import('imapflow').then(({ ImapFlow }) => {
			const data = { ...snapshot('alice').accounts[0], imapHost: 'imap.mail.me.com' };
			db.query('UPDATE accounts SET data=?,secret=? WHERE id=?').run(
				JSON.stringify(data),
				encrypt(JSON.stringify({ username: data.email, password: 'test' }), 'alice:account-alice'),
				data.id
			);
			const mocks = [
				spyOn(ImapFlow.prototype, 'connect').mockResolvedValue(undefined),
				spyOn(ImapFlow.prototype, 'logout').mockResolvedValue(undefined),
				spyOn(ImapFlow.prototype, 'getMailboxLock').mockImplementation(async function (
					this: InstanceType<typeof ImapFlow>
				) {
					this.mailbox = { exists: 1, uidValidity: 1n } as never;
					return { release() {} } as never;
				}),
				spyOn(ImapFlow.prototype, 'fetchOne').mockImplementation(fetch)
			];
			return { source: mocks[3], restore: () => mocks.forEach((mock) => mock.mockRestore()) };
		});
	}
	const rawBody = {
		source: Buffer.from(
			'From: friend@example.com\r\nContent-Type: text/plain\r\n\r\nDownloaded body'
		)
	};
	async function until(condition: () => boolean) {
		for (let attempt = 0; !condition() && attempt < 200; attempt++) await Bun.sleep(2);
		expect(condition()).toBe(true);
	}

	test('a blocked body download never delays the next inbox arrival or a flag change', async () => {
		const state = await fixture();
		const idleSource = spyOn(state.client, 'fetchOne');
		let release!: (value: never) => void;
		let first = true;
		const bodies = await bodyMocks(async () => {
			if (first) {
				first = false;
				return new Promise<never>((resolve) => {
					release = resolve;
				});
			}
			return rawBody;
		});
		const { downloadBodies, serialized } = await import('../src/lib/server/mail');
		let job: Promise<void> | undefined;
		try {
			await state.syncInbox('alice', 'account-alice', state.client);
			job = downloadBodies('alice', 'account-alice', new AbortController().signal);
			await until(() => !!release);
			const reader = (await GET(event('events'))).body!.getReader();
			await reader.read();
			const notification = reader.read();
			state.headers[0].flags.add('\\Seen');
			state.headers.push({
				...state.headers[0],
				uid: 8,
				flags: new Set(),
				envelope: { ...state.headers[0].envelope, subject: 'Second arrival' }
			});
			state.client.mailbox = { exists: 2, uidValidity: 1n } as never;
			// Metadata uses the regular mutation lock while body I/O is still blocked
			await serialized('alice', () => state.syncInbox('alice', 'account-alice', state.client));
			expect(new TextDecoder().decode((await notification).value)).toContain('event: revision');
			await reader.cancel();
			expect(snapshot('alice').messages.find((message) => message.uid === 8)?.subject).toBe(
				'Second arrival'
			);
			expect(snapshot('alice').messages.find((message) => message.uid === 7)?.read).toBe(true);
			expect(idleSource).not.toHaveBeenCalled();
			release(rawBody as never);
			await job;
			expect(snapshot('alice').messages.find((message) => message.uid === 7)?.text).toContain(
				'Downloaded body'
			);
			expect(snapshot('alice').messages.find((message) => message.uid === 7)?.read).toBe(true);
			expect(one('SELECT message_id FROM body_jobs')).toBeNull();
		} finally {
			release?.(rawBody as never);
			await job;
			idleSource.mockRestore();
			bodies.restore();
			state.restore();
		}
	});

	test('fetches envelopes only for uncached UIDs and retains cached bodies', async () => {
		const state = await fixture();
		const bodies = await bodyMocks(async () => rawBody);
		const { downloadBodies } = await import('../src/lib/server/mail');
		try {
			await state.syncInbox('alice', 'account-alice', state.client);
			await downloadBodies('alice', 'account-alice', new AbortController().signal);
			state.headers[0].flags.add('\\Seen');
			await state.syncInbox('alice', 'account-alice', state.client);
			const calls = (state.client.fetchAll as any).mock.calls;
			expect(calls.filter((call: any[]) => call[1].envelope)).toHaveLength(1);
			expect(calls.find((call: any[]) => call[1].envelope)[0]).toEqual([7]);
			expect(bodies.source).toHaveBeenCalledTimes(1);
			expect(snapshot('alice').messages[0].read).toBe(true);
			expect(snapshot('alice').messages[0].text).toContain('Downloaded body');
			state.client.mailbox = { exists: 0, uidValidity: 1n } as never;
			await state.syncInbox('alice', 'account-alice', state.client);
			expect(snapshot('alice').messages).toEqual([]);
		} finally {
			bodies.restore();
			state.restore();
		}
	});

	test('uses CONDSTORE watermarks for flag deltas and resets on UIDVALIDITY changes', async () => {
		const state = await fixture();
		state.client.enabled.add('CONDSTORE');
		state.client.mailbox = { exists: 1, uidValidity: 1n, highestModseq: 10n } as never;
		try {
			await state.syncInbox('alice', 'account-alice', state.client);
			state.headers[0].flags.add('\\Seen');
			state.client.mailbox = { exists: 1, uidValidity: 1n, highestModseq: 12n } as never;
			await state.syncInbox('alice', 'account-alice', state.client);
			expect(
				(state.client.fetchAll as any).mock.calls.some(
					(call: any[]) => call[2]?.changedSince === 10n
				)
			).toBe(true);
			expect(snapshot('alice').messages[0].read).toBe(true);
			state.client.mailbox = { exists: 1, uidValidity: 2n, highestModseq: 1n } as never;
			await state.syncInbox('alice', 'account-alice', state.client);
			expect(snapshot('alice').messages).toHaveLength(1);
			expect(snapshot('alice').messages[0].uidValidity).toBe('2');
			expect(
				(state.client.fetchAll as any).mock.calls.filter((call: any[]) => call[1].envelope)
			).toHaveLength(2);
		} finally {
			state.restore();
		}
	});

	test('a failed delta does not advance the watermark, and NOMODSEQ falls back to flags', async () => {
		const state = await fixture();
		state.client.enabled.add('CONDSTORE');
		state.client.mailbox = { exists: 1, uidValidity: 1n, highestModseq: 10n } as never;
		try {
			await state.syncInbox('alice', 'account-alice', state.client);
			state.client.mailbox = { exists: 1, uidValidity: 1n, highestModseq: 12n } as never;
			let fail = true;
			(state.client.fetchAll as any).mockImplementation(
				async (_range: unknown, _query: unknown, options: { changedSince?: bigint } = {}) => {
					if (options.changedSince && fail) {
						fail = false;
						throw new Error('Connection interrupted');
					}
					return state.headers;
				}
			);
			await expect(state.syncInbox('alice', 'account-alice', state.client)).rejects.toThrow(
				'interrupted'
			);
			state.headers[0].flags.add('\\Seen');
			await state.syncInbox('alice', 'account-alice', state.client);
			const deltas = (state.client.fetchAll as any).mock.calls.filter(
				(call: any[]) => call[2]?.changedSince
			);
			expect(deltas.map((call: any[]) => call[2].changedSince)).toEqual([10n, 10n]);
			expect(snapshot('alice').messages[0].read).toBe(true);
			state.client.mailbox = { exists: 1, uidValidity: 1n, noModseq: true } as never;
			await state.syncInbox('alice', 'account-alice', state.client);
			expect((state.client.fetchAll as any).mock.calls.at(-1)[1].flags).toBe(true);
		} finally {
			state.restore();
		}
	});

	test('failed body downloads stay queued and deleting a message removes its pending work', async () => {
		const state = await fixture();
		const bodies = await bodyMocks(async () => {
			throw new Error('Temporary outage');
		});
		const { downloadBodies, hasBodyJobs } = await import('../src/lib/server/mail');
		try {
			await state.syncInbox('alice', 'account-alice', state.client);
			await expect(
				downloadBodies('alice', 'account-alice', new AbortController().signal)
			).rejects.toThrow('Temporary outage');
			expect(hasBodyJobs('alice', 'account-alice')).toBe(true);
			expect(snapshot('alice').messages[0].html).toBeUndefined();
			db.query('DELETE FROM messages WHERE user_id=?').run('alice');
			expect(one('SELECT message_id FROM body_jobs')).toBeNull();
		} finally {
			bodies.restore();
			state.restore();
		}
	});

	test('a flag mutation finishing after a body download preserves the downloaded content', async () => {
		const state = await fixture();
		let releaseBody!: (value: never) => void;
		let releaseFlags!: () => void;
		const bodies = await bodyMocks(
			() =>
				new Promise<never>((resolve) => {
					releaseBody = resolve;
				})
		);
		const { ImapFlow } = await import('imapflow');
		const flags = spyOn(ImapFlow.prototype, 'messageFlagsAdd').mockImplementation(
			() =>
				new Promise<true>((resolve) => {
					releaseFlags = () => resolve(true);
				})
		);
		const { downloadBodies, updateMessage } = await import('../src/lib/server/mail');
		await state.syncInbox('alice', 'account-alice', state.client);
		const bodyJob = downloadBodies('alice', 'account-alice', new AbortController().signal);
		let mutation: Promise<void> | undefined;
		try {
			await until(() => !!releaseBody);
			mutation = updateMessage('alice', snapshot('alice').messages[0].id, { read: true });
			await until(() => !!releaseFlags);
			releaseBody(rawBody as never);
			await bodyJob;
			releaseFlags();
			await mutation;
			expect(snapshot('alice').messages[0].read).toBe(true);
			expect(snapshot('alice').messages[0].text).toContain('Downloaded body');
		} finally {
			releaseBody?.(rawBody as never);
			releaseFlags?.();
			await bodyJob;
			await mutation;
			flags.mockRestore();
			bodies.restore();
			state.restore();
		}
	});

	test('body completion cannot restore deleted mail or write after credentials are replaced', async () => {
		for (const action of ['delete', 'reconnect']) {
			const state = await fixture();
			let release!: (value: never) => void;
			const bodies = await bodyMocks(
				() =>
					new Promise<never>((resolve) => {
						release = resolve;
					})
			);
			const { downloadBodies } = await import('../src/lib/server/mail');
			await state.syncInbox('alice', 'account-alice', state.client);
			const job = downloadBodies('alice', 'account-alice', new AbortController().signal);
			try {
				await until(() => !!release);
				if (action === 'delete') db.query('DELETE FROM messages WHERE user_id=?').run('alice');
				else
					db.query('UPDATE accounts SET secret=? WHERE id=?').run('replacement', 'account-alice');
				release(rawBody as never);
				await job;
				if (action === 'delete') expect(snapshot('alice').messages).toEqual([]);
				else expect(snapshot('alice').messages[0].html).toBeUndefined();
			} finally {
				release?.(rawBody as never);
				await job;
				bodies.restore();
				state.restore();
			}
		}
	});
});

describe('Push notifications', () => {
	test('reuses Apple credentials unless nonempty APNs overrides are supplied', async () => {
		const names = [
			'APPLE_TEAM_ID',
			'APPLE_KEY_ID',
			'APPLE_PRIVATE_KEY',
			'APNS_TEAM_ID',
			'APNS_KEY_ID',
			'APNS_PRIVATE_KEY',
			'APNS_TOPIC'
		];
		const saved = names.map((name) => process.env[name]);
		try {
			process.env.APPLE_TEAM_ID = 'apple-team';
			process.env.APPLE_KEY_ID = 'apple-key';
			process.env.APPLE_PRIVATE_KEY = 'apple-private-key';
			process.env.APNS_TEAM_ID = '';
			delete process.env.APNS_KEY_ID;
			delete process.env.APNS_PRIVATE_KEY;
			process.env.APNS_TOPIC = 'dev.topscrech.Mail-Otter';
			const { pushCredentials, pushConfigured } = await import('../src/lib/server/push');
			expect(pushCredentials()).toEqual({
				teamId: 'apple-team',
				keyId: 'apple-key',
				privateKey: 'apple-private-key'
			});
			expect(pushConfigured()).toBe(true);
			process.env.APNS_TEAM_ID = 'push-team';
			process.env.APNS_KEY_ID = 'push-key';
			process.env.APNS_PRIVATE_KEY = 'push-private-key';
			expect(pushCredentials()).toEqual({
				teamId: 'push-team',
				keyId: 'push-key',
				privateKey: 'push-private-key'
			});
			delete process.env.APNS_TOPIC;
			expect(pushConfigured()).toBe(false);
		} finally {
			names.forEach((name, index) => {
				if (saved[index] === undefined) delete process.env[name];
				else process.env[name] = saved[index];
			});
		}
	});

	const token = 'ab'.repeat(32);
	const input = { token, environment: 'development' };
	async function setup() {
		process.env.APNS_TEAM_ID = 'team';
		process.env.APNS_KEY_ID = 'key';
		process.env.APNS_PRIVATE_KEY = 'test-key';
		process.env.APNS_TOPIC = 'dev.topscrech.Mail-Otter';
		expect((await PUT(event('push/devices', 'PUT', input))).status).toBe(200);
		return import('../src/lib/server/push');
	}
	function message(uid: number, read = false) {
		return {
			id: `push-${uid}`,
			accountId: 'account-alice',
			folder: 'inbox' as const,
			uid,
			uidValidity: '1',
			path: 'INBOX',
			from: 'Sender',
			fromAddress: 'sender@example.com',
			to: 'alice@example.com',
			subject: 'New mail',
			text: '',
			date: new Date().toISOString(),
			read,
			starred: false,
			messageId: `message-${uid}`,
			attachments: []
		};
	}
	function save(uid: number, read = false) {
		const mail = message(uid, read);
		db.query('INSERT OR REPLACE INTO messages VALUES (?,?,?,?)').run(
			mail.id,
			'alice',
			'account-alice',
			JSON.stringify(mail)
		);
		return mail;
	}
	test('mail alerts expose Delete and identify the server message rather than the email header', async () => {
		const { notificationPayload } = await import('../src/lib/server/push');
		const mail = message(1);
		const payload = notificationPayload(mail);
		expect(payload.aps.category).toBe('MAIL_MESSAGE');
		expect(payload.messageId).toBe(mail.id);
		expect(payload.messageId).not.toBe(mail.messageId);
		expect(payload.aps.alert).toEqual({ title: 'Sender', body: 'New mail' });
	});
	test('mail alerts enable avatar enrichment with bounded sender details', async () => {
		const { notificationPayload } = await import('../src/lib/server/push');
		const mail = { ...message(1), fromAddress: 'person@news.apple.com' };
		const payload = notificationPayload(mail);
		expect(payload.aps['mutable-content']).toBe(1);
		expect(payload.sender).toEqual({
			name: 'Sender',
			address: 'person@news.apple.com',
			websiteIconDomains: ['news.apple.com', 'apple.com']
		});
		expect(
			notificationPayload({ ...mail, fromAddress: 'person@gmail.com' }).sender.websiteIconDomains
		).toEqual([]);
		expect(notificationPayload({ ...mail, from: 'a'.repeat(1000) }).sender.name.length).toBe(160);
		expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(4096);
	});
	test('registration requires authentication and validates tokens and environments', async () => {
		await setup();
		expect((await PUT(event('push/devices', 'PUT', input, null))).status).toBe(401);
		expect((await PUT(event('push/devices', 'PUT', { ...input, token: 'invalid' }))).status).toBe(
			400
		);
		expect(
			(await PUT(event('push/devices', 'PUT', { ...input, environment: 'other' }))).status
		).toBe(400);
		expect((await DELETE(event('push/devices', 'DELETE', input, 'bob'))).status).toBe(200);
		expect(one('SELECT id FROM push_devices')).not.toBeNull();
	});
	test('initial mail is silent, new unread mail queues once, and UID resets are silent', async () => {
		const { queueInboxPushes } = await setup();
		queueInboxPushes('alice', 'account-alice', '1', [save(1)]);
		expect(one('SELECT id FROM push_jobs')).toBeNull();
		const messages = [message(1), save(2), save(3, true)];
		queueInboxPushes('alice', 'account-alice', '1', messages);
		queueInboxPushes('alice', 'account-alice', '1', messages);
		expect(one<{ count: number }>('SELECT count(*) count FROM push_jobs')?.count).toBe(1);
		queueInboxPushes('alice', 'account-alice', '2', [save(4)]);
		expect(one<{ count: number }>('SELECT count(*) count FROM push_jobs')?.count).toBe(1);
	});
	test('restoring an unread message is silent while real mail before and after it still queues pushes', async () => {
		const { queueInboxPushes, silenceMovedInboxMessage } = await setup();
		queueInboxPushes('alice', 'account-alice', '1', [save(1)]);
		const restored = save(3);
		silenceMovedInboxMessage({ ...restored, folder: 'trash', path: 'Trash', uid: 90 }, restored);
		// This marker is durable database state, independent of the HTTP request and process memory
		expect(one('SELECT identity FROM push_silent_arrivals')).not.toBeNull();
		const messages = [save(2), restored, save(4)];
		queueInboxPushes('alice', 'account-alice', '1', messages);
		expect(db.query('SELECT message_id FROM push_jobs ORDER BY message_id').all()).toEqual([
			{ message_id: 'push-2' },
			{ message_id: 'push-4' }
		]);
		expect(
			one<{ uid: number }>('SELECT uid FROM push_checkpoints WHERE account_id=?', 'account-alice')
				?.uid
		).toBe(4);
		expect(one('SELECT identity FROM push_silent_arrivals')).toBeNull();
		queueInboxPushes('alice', 'account-alice', '1', messages);
		expect(one<{ count: number }>('SELECT count(*) count FROM push_jobs')?.count).toBe(2);
	});

	for (const missingMessageID of [false, true]) {
		test(`a provider without destination UID mapping still restores silently: missing Message-ID=${missingMessageID}`, async () => {
			const { queueInboxPushes, silenceMovedInboxMessage } = await setup();
			queueInboxPushes('alice', 'account-alice', '1', [save(1)]);
			const restored = { ...save(3), ...(missingMessageID ? { messageId: '' } : {}) };
			db.query('UPDATE messages SET data=? WHERE id=?').run(JSON.stringify(restored), restored.id);
			silenceMovedInboxMessage({ ...restored, path: 'Trash', folder: 'trash', uid: 90 });
			queueInboxPushes('alice', 'account-alice', '1', [save(2), restored]);
			expect(db.query('SELECT message_id FROM push_jobs').all()).toEqual([
				{ message_id: 'push-2' }
			]);
			expect(one('SELECT identity FROM push_silent_arrivals')).toBeNull();
		});
	}

	test('silent restoration markers are isolated by account and removed on account disconnect', async () => {
		const { queueInboxPushes, silenceMovedInboxMessage } = await setup();
		queueInboxPushes('alice', 'account-alice', '1', [save(1)]);
		const incoming = save(2);
		silenceMovedInboxMessage({ ...incoming, accountId: 'account-bob', folder: 'trash' });
		queueInboxPushes('alice', 'account-alice', '1', [incoming]);
		expect(one('SELECT message_id FROM push_jobs')).not.toBeNull();
		db.query('DELETE FROM accounts WHERE id=?').run('account-bob');
		expect(one('SELECT identity FROM push_silent_arrivals')).toBeNull();
	});

	test('UID markers cannot suppress mail after a UIDVALIDITY reset or grow after their UID is passed', async () => {
		const { queueInboxPushes, silenceMovedInboxMessage } = await setup();
		const moved = message(3);
		silenceMovedInboxMessage(moved, moved);
		queueInboxPushes('alice', 'account-alice', '2', []);
		expect(one('SELECT identity FROM push_silent_arrivals')).toBeNull();
		const incoming = { ...save(3), uidValidity: '2' };
		queueInboxPushes('alice', 'account-alice', '2', [incoming]);
		expect(one('SELECT message_id FROM push_jobs')).not.toBeNull();
		silenceMovedInboxMessage(message(2), { ...message(2), uidValidity: '2' });
		queueInboxPushes('alice', 'account-alice', '2', [incoming]);
		expect(one('SELECT identity FROM push_silent_arrivals')).toBeNull();
	});

	test('session changes discard old queued mail and logout removes registrations', async () => {
		const { queueInboxPushes } = await setup();
		queueInboxPushes('alice', 'account-alice', '1', []);
		queueInboxPushes('alice', 'account-alice', '1', [save(1)]);
		expect((await PUT(event('push/devices', 'PUT', input, 'bob'))).status).toBe(200);
		expect(one('SELECT id FROM push_jobs')).toBeNull();
		expect(one<{ session_id: string }>('SELECT session_id FROM push_devices')?.session_id).toBe(
			'session-bob'
		);
		await POST(event('auth/logout', 'POST', {}, 'bob'));
		expect(one('SELECT id FROM push_devices')).toBeNull();
	});
	test('transient failure retries and successful delivery clears the job', async () => {
		const { queueInboxPushes, deliverPushes } = await setup();
		queueInboxPushes('alice', 'account-alice', '1', []);
		queueInboxPushes('alice', 'account-alice', '1', [save(1)]);
		await deliverPushes(async () => ({ status: 503, reason: 'ServiceUnavailable' }));
		expect(one<{ attempts: number }>('SELECT attempts FROM push_jobs')?.attempts).toBe(1);
		db.query('UPDATE push_jobs SET next_attempt=0').run();
		await deliverPushes(async () => ({ status: 200 }));
		expect(one('SELECT id FROM push_jobs')).toBeNull();
	});
	test('invalid device tokens are removed', async () => {
		const { queueInboxPushes, deliverPushes } = await setup();
		queueInboxPushes('alice', 'account-alice', '1', []);
		queueInboxPushes('alice', 'account-alice', '1', [save(1)]);
		await deliverPushes(async () => ({ status: 410, reason: 'Unregistered' }));
		expect(one('SELECT id FROM push_devices')).toBeNull();
		expect(one('SELECT id FROM push_jobs')).toBeNull();
	});
	test('expired sessions and messages read before delivery do not receive alerts', async () => {
		const { queueInboxPushes, deliverPushes } = await setup();
		queueInboxPushes('alice', 'account-alice', '1', []);
		queueInboxPushes('alice', 'account-alice', '1', [save(1)]);
		db.query('UPDATE sessions SET expires=0').run();
		let sent = 0;
		await deliverPushes(async () => {
			sent++;
			return { status: 200 };
		});
		expect(sent).toBe(0);
		db.query('UPDATE sessions SET expires=?').run(Date.now() + 60000);
		db.query('UPDATE messages SET data=? WHERE id=?').run(
			JSON.stringify(message(1, true)),
			'push-1'
		);
		await deliverPushes(async () => {
			sent++;
			return { status: 200 };
		});
		expect(sent).toBe(0);
		expect(one('SELECT id FROM push_jobs')).toBeNull();
	});
});

describe('Unlinking Sign in with Apple', () => {
	async function passkey(user: 'alice' | 'bob' = 'alice') {
		const { generateKeyPairSync, createHash, sign } = await import('node:crypto');
		const { publicKey: verifyingKey, privateKey: signingKey } = generateKeyPairSync('ec', {
			namedCurve: 'prime256v1'
		});
		const jwk = verifyingKey.export({ format: 'jwk' });
		const id = Buffer.from(`key-${user}`).toString('base64url');
		const cose = Buffer.concat([
			Buffer.from([0xa5, 1, 2, 3, 0x26, 0x20, 1, 0x21, 0x58, 0x20]),
			Buffer.from(jwk.x!, 'base64url'),
			Buffer.from([0x22, 0x58, 0x20]),
			Buffer.from(jwk.y!, 'base64url')
		]);
		db.query('INSERT INTO passkeys VALUES (?,?,?,?,?,?)').run(
			id,
			user,
			cose,
			0,
			'["internal"]',
			new Date().toISOString()
		);
		return {
			id,
			proof(challenge: string, flags = 5, requestOrigin = origin, counterValue = 1) {
				const clientData = Buffer.from(
					JSON.stringify({ type: 'webauthn.get', challenge, origin: requestOrigin })
				);
				const counter = Buffer.alloc(4);
				counter.writeUInt32BE(counterValue);
				const authenticatorData = Buffer.concat([
					createHash('sha256').update('localhost').digest(),
					Buffer.from([flags]),
					counter
				]);
				const signature = sign(
					'sha256',
					Buffer.concat([authenticatorData, createHash('sha256').update(clientData).digest()]),
					signingKey
				);
				return {
					id,
					rawId: id,
					type: 'public-key',
					clientExtensionResults: {},
					response: {
						clientDataJSON: clientData.toString('base64url'),
						authenticatorData: authenticatorData.toString('base64url'),
						signature: signature.toString('base64url'),
						userHandle: Buffer.from(user).toString('base64url')
					}
				};
			}
		};
	}
	async function options(user: 'alice' | 'bob' = 'alice') {
		return (await POST(event('auth/apple/unlink/options', 'POST', {}, user))).json();
	}
	test('requires an authenticated account with a registered passkey', async () => {
		expect((await POST(event('auth/apple/unlink/options', 'POST', {}, null))).status).toBe(401);
		expect((await POST(event('auth/apple/unlink/options', 'POST', {}))).status).toBe(409);
		expect(
			one<{ apple_sub: string }>('SELECT apple_sub FROM users WHERE id=?', 'alice')?.apple_sub
		).toBe('apple-alice');
	});
	test('verifies a fresh passkey, unlinks only Apple, and preserves mail and sessions', async () => {
		const key = await passkey();
		const challenge = await options();
		expect(challenge.options.userVerification).toBe('required');
		expect(challenge.options.allowCredentials.map((key: { id: string }) => key.id)).toEqual([
			key.id
		]);
		const payload = {
			challengeId: challenge.challengeId,
			response: key.proof(challenge.options.challenge)
		};
		expect((await POST(event('auth/apple/unlink/verify', 'POST', payload))).status).toBe(200);
		const me = await (await GET(event('me'))).json();
		expect(me.appleUserId).toBeNull();
		expect(me.appleLinked).toBe(false);
		expect(me.passkeys).toHaveLength(1);
		expect(snapshot('alice').accounts).toHaveLength(1);
		expect(one('SELECT id FROM sessions WHERE id=?', 'session-alice')).not.toBeNull();
		expect((await POST(event('auth/apple/unlink/verify', 'POST', payload))).status).not.toBe(200);
		expect((await DELETE(event(`passkeys/${key.id}`, 'DELETE'))).status).toBe(409);
		expect(one('SELECT id FROM passkeys WHERE id=?', key.id)).not.toBeNull();
		const login = await (
			await POST(event('auth/passkey/login/options', 'POST', { native: true }, null))
		).json();
		const signedIn = await POST(
			event(
				'auth/passkey/login/verify',
				'POST',
				{
					challengeId: login.challengeId,
					response: key.proof(login.options.challenge, 5, origin, 2)
				},
				null
			)
		);
		expect(signedIn.status).toBe(200);
		expect((await signedIn.json()).token).toBeString();
	});
	test('rejects another account’s passkey and challenges used by another session', async () => {
		await passkey();
		const other = await passkey('bob');
		const challenge = await options();
		expect(
			(
				await POST(
					event('auth/apple/unlink/verify', 'POST', {
						challengeId: challenge.challengeId,
						response: other.proof(challenge.options.challenge)
					})
				)
			).status
		).toBe(403);
		const sameAccount = await options();
		db.query('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(
			'session-alice-other',
			'alice',
			hash('another-token'),
			'Other',
			new Date().toISOString(),
			Date.now() + 60_000
		);
		expect(
			(
				await POST(
					event(
						'auth/apple/unlink/verify',
						'POST',
						{
							challengeId: sameAccount.challengeId,
							response: other.proof(sameAccount.options.challenge)
						},
						null,
						{ authorization: 'Bearer another-token' }
					)
				)
			).status
		).toBe(403);
		const second = await options();
		expect(
			(
				await POST(
					event(
						'auth/apple/unlink/verify',
						'POST',
						{ challengeId: second.challengeId, response: other.proof(second.options.challenge) },
						'bob'
					)
				)
			).status
		).toBe(403);
		expect((await GET(event('me'))).status).toBe(200);
		expect(
			one<{ apple_sub: string }>('SELECT apple_sub FROM users WHERE id=?', 'alice')?.apple_sub
		).toBe('apple-alice');
	});
	test('rejects missing user verification, wrong origins, invalid signatures, and expired or login challenges', async () => {
		const key = await passkey();
		for (const kind of ['no-uv', 'origin', 'signature', 'expired', 'login']) {
			const challenge = await options();
			const response = key.proof(
				challenge.options.challenge,
				kind === 'no-uv' ? 1 : 5,
				kind === 'origin' ? 'https://evil.example' : origin
			);
			if (kind === 'signature')
				response.response.signature = Buffer.alloc(64).toString('base64url');
			if (kind === 'expired')
				db.query('UPDATE challenges SET expires=0 WHERE id=?').run(challenge.challengeId);
			if (kind === 'login')
				db.query("UPDATE challenges SET kind='login' WHERE id=?").run(challenge.challengeId);
			expect(
				(
					await POST(
						event('auth/apple/unlink/verify', 'POST', {
							challengeId: challenge.challengeId,
							response
						})
					)
				).status
			).not.toBe(200);
			expect(
				one<{ apple_sub: string }>('SELECT apple_sub FROM users WHERE id=?', 'alice')?.apple_sub
			).toBe('apple-alice');
		}
	});
});

describe('Linking Sign in with Apple', () => {
	beforeEach(() => {
		db.query('UPDATE users SET apple_sub=NULL WHERE id=?').run('alice');
	});
	const identity = (nonce: string, sub = 'apple-relinked', audience = 'dev.topscrech.Mail-Otter') =>
		new SignJWT({ sub, nonce })
			.setProtectedHeader({ alg: 'RS256' })
			.setIssuer('https://appleid.apple.com')
			.setAudience(audience)
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(privateKey);
	const options = async () => (await POST(event('auth/apple/link/options', 'POST', {}))).json();
	const verify = async (challengeId: string, identityToken: string) =>
		POST(event('auth/apple/link/verify', 'POST', { challengeId, identityToken }));

	test('requires authentication and an unlinked account', async () => {
		expect((await POST(event('auth/apple/link/options', 'POST', {}, null))).status).toBe(401);
		expect((await POST(event('auth/apple/link/verify', 'POST', {}, null))).status).toBe(401);
		expect((await POST(event('auth/apple/link/options', 'POST', {}, 'bob'))).status).toBe(409);
	});
	test('links to the current account and subsequent Apple sign-in opens the same workspace', async () => {
		const challenge = await options();
		expect((await verify(challenge.challengeId, await identity(challenge.nonce))).status).toBe(200);
		const me = await (await GET(event('me'))).json();
		expect(me.id).toBe('alice');
		expect(me.appleUserId).toBe('apple-relinked');
		expect(me.appleLinked).toBe(true);
		expect(snapshot('alice').accounts[0].id).toBe('account-alice');
		expect(one<{ n: number }>('SELECT count(*) n FROM users')?.n).toBe(2);
		expect(one<{ n: number }>('SELECT count(*) n FROM sessions')?.n).toBe(2);
		const login = await (await POST(event('auth/apple/native/options', 'POST', {}, null))).json();
		const signedIn = await (
			await POST(
				event(
					'auth/apple/native',
					'POST',
					{ challengeId: login.challengeId, identityToken: await identity(login.nonce) },
					null
				)
			)
		).json();
		const signedInProfile = await (
			await GET(event('me', 'GET', undefined, null, { authorization: `Bearer ${signedIn.token}` }))
		).json();
		expect(signedInProfile.id).toBe('alice');
	});
	test('refuses an Apple identity owned by another account without merging or replacing anything', async () => {
		const challenge = await options();
		expect(
			(await verify(challenge.challengeId, await identity(challenge.nonce, 'apple-bob'))).status
		).toBe(409);
		expect((await (await GET(event('me'))).json()).appleUserId).toBeNull();
		expect((await (await GET(event('me', 'GET', undefined, 'bob'))).json()).appleUserId).toBe(
			'apple-bob'
		);
		expect(snapshot('alice').accounts[0].id).toBe('account-alice');
	});
	test('rejects mismatched nonces, other audiences, expired challenges and replay', async () => {
		for (const kind of ['nonce', 'audience', 'expired']) {
			const challenge = await options();
			if (kind === 'expired')
				db.query('UPDATE challenges SET expires=0 WHERE id=?').run(challenge.challengeId);
			const token = await identity(
				kind === 'nonce' ? 'wrong' : challenge.nonce,
				'apple-relinked',
				kind === 'audience' ? 'com.other.app' : 'dev.topscrech.Mail-Otter'
			);
			expect((await verify(challenge.challengeId, token)).status).not.toBe(200);
			expect((await verify(challenge.challengeId, token)).status).toBe(400);
			expect((await (await GET(event('me'))).json()).appleUserId).toBeNull();
		}
	});
	test('binds linking to the original session and separates link challenges from login', async () => {
		const challenge = await options();
		db.query('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(
			'session-alice-new',
			'alice',
			hash('new-session-token'),
			'Other',
			new Date().toISOString(),
			Date.now() + 60_000
		);
		expect(
			(
				await POST(
					event(
						'auth/apple/link/verify',
						'POST',
						{ challengeId: challenge.challengeId, identityToken: await identity(challenge.nonce) },
						null,
						{ authorization: 'Bearer new-session-token' }
					)
				)
			).status
		).toBe(403);
		const second = await options();
		expect(
			(
				await POST(
					event(
						'auth/apple/link/verify',
						'POST',
						{ challengeId: second.challengeId, identityToken: await identity(second.nonce) },
						'bob'
					)
				)
			).status
		).toBe(403);
		const login = await (await POST(event('auth/apple/native/options', 'POST', {}, null))).json();
		expect((await verify(login.challengeId, await identity(login.nonce))).status).toBe(400);
		const third = await options();
		expect(
			(
				await POST(
					event(
						'auth/apple/native',
						'POST',
						{ challengeId: third.challengeId, identityToken: await identity(third.nonce) },
						null
					)
				)
			).status
		).toBe(400);
		expect((await (await GET(event('me'))).json()).appleUserId).toBeNull();
	});
	test('does not overwrite an Apple link established while authorization was in progress', async () => {
		const challenge = await options();
		db.query('UPDATE users SET apple_sub=? WHERE id=?').run('apple-already-linked', 'alice');
		expect((await verify(challenge.challengeId, await identity(challenge.nonce))).status).toBe(409);
		expect((await (await GET(event('me'))).json()).appleUserId).toBe('apple-already-linked');
	});
});

describe('Debug email source', () => {
	async function setup(
		options: { changedMailbox?: boolean; size?: number; missing?: boolean } = {}
	) {
		const { ImapFlow } = await import('imapflow');
		const data = { ...snapshot('alice').accounts[0], imapHost: 'imap.mail.me.com' };
		db.query('UPDATE accounts SET data=?,secret=? WHERE id=?').run(
			JSON.stringify(data),
			encrypt(JSON.stringify({ username: data.email, password: 'test' }), 'alice:account-alice'),
			data.id
		);
		db.query('INSERT INTO messages VALUES (?,?,?,?)').run(
			'debug-mail',
			'alice',
			data.id,
			JSON.stringify({
				id: 'debug-mail',
				accountId: data.id,
				path: 'INBOX',
				uid: 7,
				uidValidity: '1'
			})
		);
		const source =
			'Received: first\r\nReceived: second\r\nX-Debug: original\r\nContent-Type: text/html\r\n\r\n<p>Complete body</p>';
		let released = false;
		const fetch = spyOn(ImapFlow.prototype, 'fetchOne').mockImplementation(
			async (_uid, query, flags) => {
				expect(_uid).toBe(7);
				expect(flags?.uid).toBe(true);
				if (options.missing) return false;
				return (
					query?.size ? { size: options.size ?? source.length } : { source: Buffer.from(source) }
				) as never;
			}
		);
		const logout = spyOn(ImapFlow.prototype, 'logout').mockResolvedValue(undefined);
		const mocks = [
			fetch,
			logout,
			spyOn(ImapFlow.prototype, 'connect').mockResolvedValue(undefined),
			spyOn(ImapFlow.prototype, 'getMailboxLock').mockImplementation(async function (
				this: InstanceType<typeof ImapFlow>
			) {
				this.mailbox = { uidValidity: options.changedMailbox ? 2n : 1n } as never;
				return {
					release() {
						released = true;
					}
				} as never;
			})
		];
		return {
			source,
			fetch,
			logout,
			released: () => released,
			restore: () => mocks.forEach((mock) => mock.mockRestore())
		};
	}

	test('copies every original header and the full body without caching or marking read', async () => {
		const state = await setup();
		try {
			const flags = spyOn((await import('imapflow')).ImapFlow.prototype, 'messageFlagsAdd');
			try {
				const response = await GET(event('messages/source?id=debug-mail'));
				expect(response.status).toBe(200);
				expect(response.headers.get('cache-control')).toBe('no-store');
				expect(await response.text()).toBe(state.source);
				expect(flags).not.toHaveBeenCalled();
				expect(state.released()).toBe(true);
				expect(state.logout).toHaveBeenCalledTimes(1);
			} finally {
				flags.mockRestore();
			}
		} finally {
			state.restore();
		}
	});

	test('requires authentication and message ownership before contacting the provider', async () => {
		const state = await setup();
		try {
			expect(
				(await GET(event('messages/source?id=debug-mail', 'GET', undefined, null))).status
			).toBe(401);
			expect(
				(await GET(event('messages/source?id=debug-mail', 'GET', undefined, 'bob'))).status
			).toBe(404);
			expect(state.fetch).not.toHaveBeenCalled();
		} finally {
			state.restore();
		}
	});

	for (const [options, status] of [
		[{ changedMailbox: true }, 409],
		[{ size: 21 * 1024 * 1024 }, 413],
		[{ missing: true }, 404]
	] as const) {
		test(`rejects unavailable or oversized source with ${status} and releases the connection`, async () => {
			const state = await setup(options);
			try {
				expect((await GET(event('messages/source?id=debug-mail'))).status).toBe(status);
				expect(state.fetch.mock.calls.length).toBe(status === 409 ? 0 : 1);
				expect(state.released()).toBe(true);
				expect(state.logout).toHaveBeenCalledTimes(1);
			} finally {
				state.restore();
			}
		});
	}
});
