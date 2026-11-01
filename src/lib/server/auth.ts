import type { RequestEvent } from '@sveltejs/kit';
import {
	generateRegistrationOptions,
	generateAuthenticationOptions,
	verifyRegistrationResponse,
	verifyAuthenticationResponse,
	type RegistrationResponseJSON,
	type AuthenticationResponseJSON,
	type AuthenticatorTransport
} from '@simplewebauthn/server';
import { createRemoteJWKSet, importPKCS8, SignJWT, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { db, one, all, challenge, consume, type User } from './db';
import { origin, rpID, secure, assert, appleConfigured, ApiError } from './config';
import { opaque, hash } from './crypto';
const duration = 30 * 86400;
export interface Session {
	id: string;
	user_id: string;
	token_hash: string;
	label: string;
	created_at: string;
	expires: number;
}
interface Passkey {
	id: string;
	user_id: string;
	public_key: Uint8Array;
	counter: number;
	transports: string;
	created_at: string;
}
export function session(event: RequestEvent) {
	const bearer = event.request.headers.get('authorization');
	const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : event.cookies.get('session');
	return token
		? one<Session>(
				'SELECT * FROM sessions WHERE token_hash=? AND expires>?',
				hash(token),
				Date.now()
			)
		: null;
}
export function requireSession(event: RequestEvent) {
	const current = session(event);
	assert(current, 'Sign in to continue', 401);
	return current;
}
function newSession(event: RequestEvent, userId: string, native = false) {
	const token = opaque();
	db.query('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(
		crypto.randomUUID(),
		userId,
		hash(token),
		(event.request.headers.get('user-agent') || 'Native client').slice(0, 180),
		new Date().toISOString(),
		Date.now() + duration * 1000
	);
	event.cookies.set('session', token, {
		path: '/',
		httpOnly: true,
		secure,
		sameSite: 'lax',
		maxAge: duration
	});
	return { ok: true, ...(native ? { token, expiresIn: duration } : {}) };
}
export function profile(event: RequestEvent) {
	const current = requireSession(event);
	const user = one<User>('SELECT * FROM users WHERE id=?', current.user_id)!;
	return {
		id: user.id,
		name: user.name,
		email: user.email,
		appleUserId: user.apple_sub,
		appleLinked: user.apple_sub !== null,
		passkeys: all<Passkey>('SELECT id,created_at FROM passkeys WHERE user_id=?', user.id).map(
			(x) => ({ id: x.id, createdAt: x.created_at })
		),
		sessions: all<Session>(
			'SELECT id,label,created_at FROM sessions WHERE user_id=? AND expires>?',
			user.id,
			Date.now()
		).map((x) => ({
			id: x.id,
			label: x.label,
			createdAt: x.created_at,
			current: x.id === current.id
		}))
	};
}
export async function passkeyOptions(event: RequestEvent, register: boolean, native: boolean) {
	const current = register ? requireSession(event) : null;
	const id = opaque();
	let options;
	if (register) {
		const user = one<User>('SELECT * FROM users WHERE id=?', current!.user_id)!;
		options = await generateRegistrationOptions({
			rpName: 'Mail Otter',
			rpID,
			userName: user.email || user.name,
			userID: new TextEncoder().encode(user.id),
			attestationType: 'none',
			authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
			excludeCredentials: all<Passkey>('SELECT id FROM passkeys WHERE user_id=?', user.id).map(
				(x) => ({ id: x.id })
			)
		});
	} else options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
	challenge(id, register ? 'register' : 'login', {
		challenge: options.challenge,
		userId: current?.user_id,
		sessionId: current?.id,
		native
	});
	event.cookies.set('webauthn', id, {
		path: '/',
		httpOnly: true,
		secure,
		sameSite: 'strict',
		maxAge: 300
	});
	return { options, challengeId: id };
}
export async function passkeyVerify(
	event: RequestEvent,
	register: boolean,
	data: { challengeId: string; response: RegistrationResponseJSON | AuthenticationResponseJSON }
) {
	const bearer = event.request.headers.has('authorization');
	const browser = event.request.headers.has('origin');
	if (browser && !bearer)
		assert(event.cookies.get('webauthn') === data.challengeId, 'Sign-in session mismatch');
	const pending = consume<{
		challenge: string;
		userId?: string;
		sessionId?: string;
		native: boolean;
	}>(data.challengeId, register ? 'register' : 'login');
	if (register) {
		const current = requireSession(event);
		assert(
			current.user_id === pending.userId && current.id === pending.sessionId,
			'Sign-in session changed'
		);
		const result = await verifyRegistrationResponse({
			response: data.response as RegistrationResponseJSON,
			expectedChallenge: pending.challenge,
			expectedOrigin: origin,
			expectedRPID: rpID,
			requireUserVerification: true
		});
		assert(result.verified && result.registrationInfo, 'Passkey could not be verified');
		const c = result.registrationInfo.credential;
		db.query('INSERT INTO passkeys VALUES (?,?,?,?,?,?)').run(
			c.id,
			current.user_id,
			c.publicKey,
			c.counter,
			JSON.stringify(c.transports || []),
			new Date().toISOString()
		);
		return { ok: true };
	}
	const key = one<Passkey>('SELECT * FROM passkeys WHERE id=?', data.response.id);
	assert(key, 'This passkey is not registered', 401);
	const result = await verifyAuthenticationResponse({
		response: data.response as AuthenticationResponseJSON,
		expectedChallenge: pending.challenge,
		expectedOrigin: origin,
		expectedRPID: rpID,
		requireUserVerification: true,
		credential: {
			id: key.id,
			publicKey: new Uint8Array(key.public_key),
			counter: key.counter,
			transports: JSON.parse(key.transports) as AuthenticatorTransport[]
		}
	});
	assert(result.verified, 'Passkey could not be verified', 401);
	db.query('UPDATE passkeys SET counter=? WHERE id=?').run(
		result.authenticationInfo.newCounter,
		key.id
	);
	event.cookies.delete('webauthn', { path: '/' });
	return newSession(event, key.user_id, pending.native);
}
export async function appleUnlinkOptions(event: RequestEvent) {
	const current = requireSession(event);
	const user = one<User>('SELECT * FROM users WHERE id=?', current.user_id)!;
	assert(user.apple_sub, 'Sign in with Apple is already unlinked', 409);
	const keys = all<Passkey>('SELECT * FROM passkeys WHERE user_id=?', current.user_id);
	assert(keys.length, 'Add a passkey before unlinking Sign in with Apple', 409);
	const options = await generateAuthenticationOptions({
		rpID,
		userVerification: 'required',
		allowCredentials: keys.map((key) => ({ id: key.id, transports: JSON.parse(key.transports) }))
	});
	const challengeId = opaque();
	challenge(challengeId, 'apple-unlink', {
		challenge: options.challenge,
		userId: current.user_id,
		sessionId: current.id
	});
	return { options, challengeId };
}

export async function appleUnlinkVerify(
	event: RequestEvent,
	data: { challengeId: string; response: AuthenticationResponseJSON }
) {
	const current = requireSession(event);
	assert(
		typeof data.challengeId === 'string' && data.response && typeof data.response.id === 'string',
		'Missing passkey verification'
	);
	const pending = consume<{ challenge: string; userId: string; sessionId: string }>(
		data.challengeId,
		'apple-unlink'
	);
	assert(
		current.user_id === pending.userId && current.id === pending.sessionId,
		'Sign-in session changed',
		403
	);
	const key = one<Passkey>(
		'SELECT * FROM passkeys WHERE id=? AND user_id=?',
		data.response.id,
		current.user_id
	);
	assert(key, 'Use a passkey registered to this account', 403);
	const result = await verifyAuthenticationResponse({
		response: data.response,
		expectedChallenge: pending.challenge,
		expectedOrigin: origin,
		expectedRPID: rpID,
		requireUserVerification: true,
		credential: {
			id: key.id,
			publicKey: new Uint8Array(key.public_key),
			counter: key.counter,
			transports: JSON.parse(key.transports) as AuthenticatorTransport[]
		}
	});
	assert(result.verified, 'Passkey could not be verified', 401);
	db.transaction(() => {
		const active = requireSession(event);
		assert(active.id === current.id, 'Sign-in session changed', 403);
		const saved = one<Passkey>(
			'SELECT * FROM passkeys WHERE id=? AND user_id=?',
			key.id,
			current.user_id
		);
		assert(saved && saved.counter === key.counter, 'Passkey changed — please try again', 409);
		db.query('UPDATE passkeys SET counter=? WHERE id=?').run(
			result.authenticationInfo.newCounter,
			key.id
		);
		db.query('UPDATE users SET apple_sub=NULL WHERE id=?').run(current.user_id);
	})();
	return { ok: true };
}

export function removePasskey(event: RequestEvent, id: string) {
	const current = requireSession(event);
	db.transaction(() => {
		const user = one<User>('SELECT * FROM users WHERE id=?', current.user_id)!;
		const keys = all<Passkey>('SELECT * FROM passkeys WHERE user_id=?', current.user_id);
		assert(
			user.apple_sub || keys.length > 1 || !keys.some((key) => key.id === id),
			'Keep at least one passkey while Sign in with Apple is unlinked',
			409
		);
		db.query('DELETE FROM passkeys WHERE id=? AND user_id=?').run(id, current.user_id);
	})();
}

let appleKeys: JWTVerifyGetKey = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
/** Lets tests verify Apple identity tokens against local keys */
export function useAppleKeys(keys: JWTVerifyGetKey) {
	appleKeys = keys;
}
/** Bundle identifiers whose native Sign in with Apple tokens are accepted */
export const appleAppIds = () =>
	(process.env.APPLE_APP_IDS || 'dev.topscrech.Mail-Otter')
		.split(',')
		.map((x) => x.trim())
		.filter(Boolean);
function appleUser(sub: string, name: string, email: unknown) {
	let user = one<User>('SELECT * FROM users WHERE apple_sub=?', sub);
	if (!user) {
		db.query(
			'INSERT INTO users (id,apple_sub,name,email) VALUES (?,?,?,?) ON CONFLICT(apple_sub) DO NOTHING'
		).run(
			crypto.randomUUID(),
			sub,
			name.slice(0, 120) || 'Your workspace',
			typeof email === 'string' ? email : ''
		);
		user = one<User>('SELECT * FROM users WHERE apple_sub=?', sub)!;
	}
	return user;
}
export function appleNativeOptions() {
	const challengeId = opaque();
	const nonce = opaque();
	challenge(challengeId, 'apple-native', { nonce });
	return { challengeId, nonce };
}
export async function appleNativeVerify(
	event: RequestEvent,
	data: { challengeId?: unknown; identityToken?: unknown; name?: unknown }
) {
	assert(
		typeof data.challengeId === 'string' && typeof data.identityToken === 'string',
		'Missing Apple sign-in details'
	);
	const pending = consume<{ nonce: string }>(data.challengeId, 'apple-native');
	const payload = await verifyAppleIdentity(data.identityToken, pending.nonce);
	const name = typeof data.name === 'string' ? data.name.trim() : '';
	return newSession(event, appleUser(payload.sub, name, payload.email).id, true);
}
async function verifyAppleIdentity(identityToken: string, nonce: string) {
	let payload;
	try {
		({ payload } = await jwtVerify(identityToken, appleKeys, {
			issuer: 'https://appleid.apple.com',
			audience: appleAppIds(),
			algorithms: ['RS256']
		}));
	} catch {
		throw new ApiError(401, 'Apple identity could not be verified');
	}
	assert(payload.sub && payload.nonce === nonce, 'Apple identity could not be verified', 401);
	return payload;
}

export function appleLinkOptions(event: RequestEvent) {
	const current = requireSession(event);
	const user = one<User>('SELECT * FROM users WHERE id=?', current.user_id)!;
	assert(!user.apple_sub, 'Sign in with Apple is already linked', 409);
	const challengeId = opaque();
	const nonce = opaque();
	challenge(challengeId, 'apple-link', { nonce, userId: current.user_id, sessionId: current.id });
	return { challengeId, nonce };
}

export async function appleLinkVerify(
	event: RequestEvent,
	data: { challengeId?: unknown; identityToken?: unknown }
) {
	const current = requireSession(event);
	assert(
		typeof data.challengeId === 'string' && typeof data.identityToken === 'string',
		'Missing Apple linking details'
	);
	const pending = consume<{ nonce: string; userId: string; sessionId: string }>(
		data.challengeId,
		'apple-link'
	);
	assert(
		current.user_id === pending.userId && current.id === pending.sessionId,
		'Sign-in session changed',
		403
	);
	const payload = await verifyAppleIdentity(data.identityToken, pending.nonce);
	db.transaction(() => {
		const active = requireSession(event);
		assert(active.id === current.id, 'Sign-in session changed', 403);
		const user = one<User>('SELECT * FROM users WHERE id=?', current.user_id)!;
		assert(!user.apple_sub, 'Sign in with Apple is already linked', 409);
		assert(
			!one<User>('SELECT * FROM users WHERE apple_sub=?', payload.sub!),
			'This Apple Account is already linked to another Mail Otter account',
			409
		);
		db.query('UPDATE users SET apple_sub=? WHERE id=?').run(payload.sub!, current.user_id);
	})();
	return { ok: true };
}

export function appleStart(event: RequestEvent) {
	assert(appleConfigured(), 'Sign in with Apple needs to be configured on this server', 503);
	const state = opaque();
	const nonce = opaque();
	challenge(state, 'apple', { nonce });
	event.cookies.set('apple-state', state, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'none',
		maxAge: 300
	});
	const query = new URLSearchParams({
		client_id: process.env.APPLE_CLIENT_ID!,
		redirect_uri: `${origin}/api/v1/auth/apple/callback`,
		response_type: 'code',
		response_mode: 'form_post',
		scope: 'name email',
		state,
		nonce
	});
	return `https://appleid.apple.com/auth/authorize?${query}`;
}
export async function appleCallback(event: RequestEvent) {
	const form = await event.request.formData();
	const state = String(form.get('state') || '');
	assert(state && state === event.cookies.get('apple-state'), 'Apple sign-in session mismatch');
	event.cookies.delete('apple-state', { path: '/' });
	const pending = consume<{ nonce: string }>(state, 'apple');
	assert(!form.get('error') && form.get('code'), 'Apple sign-in was cancelled');
	const key = await importPKCS8(process.env.APPLE_PRIVATE_KEY!.replaceAll('\\n', '\n'), 'ES256');
	const secret = await new SignJWT({})
		.setProtectedHeader({ alg: 'ES256', kid: process.env.APPLE_KEY_ID! })
		.setIssuer(process.env.APPLE_TEAM_ID!)
		.setSubject(process.env.APPLE_CLIENT_ID!)
		.setAudience('https://appleid.apple.com')
		.setIssuedAt()
		.setExpirationTime('5m')
		.sign(key);
	const response = await fetch('https://appleid.apple.com/auth/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: process.env.APPLE_CLIENT_ID!,
			client_secret: secret,
			code: String(form.get('code')),
			grant_type: 'authorization_code',
			redirect_uri: `${origin}/api/v1/auth/apple/callback`
		}),
		signal: AbortSignal.timeout(15_000)
	});
	const tokens = await response.json();
	assert(response.ok && tokens.id_token, 'Apple could not complete sign-in', 401);
	const { payload } = await jwtVerify(tokens.id_token, appleKeys, {
		issuer: 'https://appleid.apple.com',
		audience: process.env.APPLE_CLIENT_ID!,
		algorithms: ['RS256']
	});
	assert(
		payload.sub && payload.nonce === pending.nonce,
		'Apple identity could not be verified',
		401
	);
	let name = '';
	try {
		const supplied = JSON.parse(String(form.get('user') || '{}'));
		name = [supplied.name?.firstName, supplied.name?.lastName].filter(Boolean).join(' ');
	} catch {
		/* Apple sends the name only on the first authorization */
	}
	const user = appleUser(payload.sub, name, payload.email);
	newSession(event, user.id);
	return '/';
}
