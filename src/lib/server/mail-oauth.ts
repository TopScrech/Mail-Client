import { createHash } from 'node:crypto';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import type { RequestEvent } from '@sveltejs/kit';
import { assert, origin, secure, ApiError } from './config';
import { opaque, hash } from './crypto';
import { challenge, consume } from './db';
import { requireSession } from './auth';

export type MailProvider = 'google' | 'microsoft';
export interface OAuthTokens {
	provider: MailProvider;
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}
export interface Credentials {
	username: string;
	password?: string;
	oauth?: OAuthTokens;
}
const providers = {
	google: {
		authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
		token: 'https://oauth2.googleapis.com/token',
		scope: 'openid email https://mail.google.com/',
		keys: createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))
	},
	microsoft: {
		authorization: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
		token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
		scope:
			'openid email profile offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send',
		keys: createRemoteJWKSet(
			new URL('https://login.microsoftonline.com/common/discovery/v2.0/keys')
		)
	}
};
export function mailProvider(value: string): MailProvider {
	assert(value === 'google' || value === 'microsoft', 'Unknown mail provider');
	return value;
}
export function oauthConfigured(provider: MailProvider) {
	return !!(
		process.env[`${provider.toUpperCase()}_CLIENT_ID`] &&
		process.env[`${provider.toUpperCase()}_CLIENT_SECRET`]
	);
}
function client(provider: MailProvider) {
	assert(
		oauthConfigured(provider),
		`${provider === 'google' ? 'Google' : 'Microsoft'} mail connection is not configured on this server`,
		503
	);
	return {
		client_id: process.env[`${provider.toUpperCase()}_CLIENT_ID`]!,
		client_secret: process.env[`${provider.toUpperCase()}_CLIENT_SECRET`]!
	};
}
const callback = (provider: MailProvider) => `${origin}/api/v1/mail/oauth/${provider}/callback`;
export function mailOAuthStart(event: RequestEvent, provider: MailProvider) {
	const session = requireSession(event);
	const { client_id } = client(provider);
	const state = opaque(),
		verifier = opaque(),
		nonce = opaque();
	challenge(hash(state), `mail-${provider}`, { sessionId: session.id, verifier, nonce });
	event.cookies.set(`mail_oauth_${provider}`, state, {
		path: '/',
		httpOnly: true,
		secure,
		sameSite: 'lax',
		maxAge: 300
	});
	const url = new URL(providers[provider].authorization);
	url.search = new URLSearchParams({
		client_id,
		redirect_uri: callback(provider),
		response_type: 'code',
		scope: providers[provider].scope,
		state,
		nonce,
		code_challenge: createHash('sha256').update(verifier).digest('base64url'),
		code_challenge_method: 'S256',
		prompt: provider === 'google' ? 'consent' : 'select_account',
		...(provider === 'google' ? { access_type: 'offline' } : {})
	}).toString();
	return url.toString();
}
async function tokenRequest(provider: MailProvider, fields: Record<string, string>) {
	const response = await fetch(providers[provider].token, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ ...client(provider), ...fields }),
		signal: AbortSignal.timeout(15000)
	});
	if (!response.ok)
		throw new ApiError(422, 'Mail authorization failed — connect the account again');
	const result = await response.json();
	assert(
		typeof result.access_token === 'string' &&
			result.token_type?.toLowerCase() === 'bearer' &&
			Number(result.expires_in) > 0,
		'Invalid mail authorization response',
		502
	);
	return result;
}
export async function refreshOAuth(tokens: OAuthTokens): Promise<OAuthTokens> {
	if (tokens.expiresAt > Date.now() + 60000) return tokens;
	const result = await tokenRequest(tokens.provider, {
		grant_type: 'refresh_token',
		refresh_token: tokens.refreshToken
	});
	return {
		...tokens,
		accessToken: result.access_token,
		refreshToken: result.refresh_token || tokens.refreshToken,
		expiresAt: Date.now() + Number(result.expires_in) * 1000
	};
}
export async function mailOAuthCallback(event: RequestEvent, provider: MailProvider) {
	const session = requireSession(event);
	const state = event.url.searchParams.get('state');
	const cookie = event.cookies.get(`mail_oauth_${provider}`);
	event.cookies.delete(`mail_oauth_${provider}`, { path: '/' });
	assert(state && state === cookie, 'Mail authorization expired — try connecting again');
	const pending = consume<{ sessionId: string; verifier: string; nonce: string }>(
		hash(state),
		`mail-${provider}`
	);
	assert(pending.sessionId === session.id, 'Mail authorization belongs to another session', 403);
	assert(
		!event.url.searchParams.has('error'),
		'Mail connection was cancelled or permission was denied'
	);
	const code = event.url.searchParams.get('code');
	assert(code, 'Missing mail authorization code');
	const result = await tokenRequest(provider, {
		grant_type: 'authorization_code',
		code,
		code_verifier: pending.verifier,
		redirect_uri: callback(provider)
	});
	assert(
		typeof result.id_token === 'string' && typeof result.refresh_token === 'string',
		'Offline mail access was not granted — try connecting again'
	);
	let issuer: string | string[] = ['https://accounts.google.com', 'accounts.google.com'];
	if (provider === 'microsoft') {
		const { tid } = decodeJwt(result.id_token);
		assert(typeof tid === 'string' && /^[0-9a-f-]{36}$/i.test(tid), 'Invalid Microsoft tenant');
		issuer = `https://login.microsoftonline.com/${tid}/v2.0`;
	}
	const { payload } = await jwtVerify(result.id_token, providers[provider].keys, {
		audience: client(provider).client_id,
		issuer,
		algorithms: ['RS256']
	});
	assert(payload.nonce === pending.nonce, 'Invalid mail authorization nonce');
	const email =
		payload.email || (provider === 'microsoft' ? payload.preferred_username : undefined);
	assert(
		typeof email === 'string' && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email),
		'The provider did not return a mailbox address'
	);
	if (provider === 'google')
		assert(payload.email_verified === true, 'Google email is not verified');
	return {
		email,
		credentials: {
			username: email,
			oauth: {
				provider,
				accessToken: result.access_token,
				refreshToken: result.refresh_token,
				expiresAt: Date.now() + Number(result.expires_in) * 1000
			}
		} satisfies Credentials
	};
}
