import { json, type RequestEvent } from '@sveltejs/kit';
import { ApiError, assert, origin, appleConfigured, allowedHosts } from '$lib/server/config';
import { db, one, all, limit, cleanup, bump, snapshot, type User } from '$lib/server/db';
import {
	session,
	requireSession,
	profile,
	appleStart,
	appleCallback,
	passkeyOptions,
	passkeyVerify
} from '$lib/server/auth';
import {
	serialized,
	connectAccount,
	syncAccount,
	updateMessage,
	attachment,
	send
} from '$lib/server/mail';
import type { Draft, Folder } from '$lib/types';
import { hash } from '$lib/server/crypto';
async function body(event: RequestEvent) {
	try {
		return await event.request.json();
	} catch {
		throw new ApiError(400, 'Invalid JSON request');
	}
}
async function dispatch(event: RequestEvent): Promise<Response> {
	const path = event.params.path || '';
	const method = event.request.method;
	const current = session(event);
	if (method !== 'GET' && path !== 'auth/apple/callback') {
		const source = event.request.headers.get('origin');
		assert(
			source ? source === origin : !current || event.request.headers.has('authorization'),
			'Request origin is not allowed',
			403
		);
	}
	if (path.startsWith('auth/')) {
		cleanup();
		limit(`auth:${hash(event.getClientAddress())}`, 30);
	}
	if (path === 'config' && method === 'GET')
		return json({ appleEnabled: appleConfigured(), mailHosts: allowedHosts() });
	if (path === 'auth/apple/start' && method === 'GET')
		return new Response(null, { status: 302, headers: { location: appleStart(event) } });
	if (path === 'auth/apple/callback' && method === 'POST')
		return new Response(null, { status: 303, headers: { location: await appleCallback(event) } });
	if (path === 'auth/passkey/login/options' && method === 'POST')
		return json(await passkeyOptions(event, false, (await body(event)).native === true));
	if (path === 'auth/passkey/login/verify' && method === 'POST')
		return json(await passkeyVerify(event, false, await body(event)));
	const auth = requireSession(event);
	const uid = auth.user_id;
	if (path === 'me' && method === 'GET') return json(profile(event));
	if (path === 'auth/passkey/register/options' && method === 'POST')
		return json(await passkeyOptions(event, true, false));
	if (path === 'auth/passkey/register/verify' && method === 'POST')
		return json(await passkeyVerify(event, true, await body(event)));
	if (path === 'auth/logout' && method === 'POST') {
		db.query('DELETE FROM sessions WHERE id=?').run(auth.id);
		event.cookies.delete('session', { path: '/' });
		return json({ ok: true });
	}
	if (path.startsWith('sessions/') && method === 'DELETE') {
		const id = path.slice(9);
		db.query('DELETE FROM sessions WHERE id=? AND user_id=?').run(id, uid);
		if (id === auth.id) event.cookies.delete('session', { path: '/' });
		return json({ ok: true });
	}
	if (path.startsWith('passkeys/') && method === 'DELETE') {
		db.query('DELETE FROM passkeys WHERE id=? AND user_id=?').run(path.slice(9), uid);
		return json({ ok: true });
	}
	if (path === 'sync' && method === 'GET') {
		const revision = one<User>('SELECT revision FROM users WHERE id=?', uid)!.revision;
		if (event.url.searchParams.get('since') === String(revision))
			return new Response(null, { status: 204 });
		return json(snapshot(uid));
	}
	if (path === 'accounts' && method === 'POST') {
		limit(`connect:${uid}`, 10, 3600_000);
		const input = await body(event);
		return json(await serialized(uid, () => connectAccount(uid, input)), { status: 201 });
	}
	if (path.startsWith('accounts/') && method === 'DELETE')
		return serialized(uid, async () => {
			const id = path.slice(9);
			db.transaction(() => {
				db.query('DELETE FROM accounts WHERE id=? AND user_id=?').run(id, uid);
				for (const row of all<{ id: string; data: string }>(
					'SELECT id,data FROM drafts WHERE user_id=?',
					uid
				))
					if (JSON.parse(row.data).accountId === id)
						db.query('DELETE FROM drafts WHERE id=? AND user_id=?').run(row.id, uid);
				bump(uid);
			})();
			return json({ ok: true });
		});
	if (path === 'mail/sync' && method === 'POST') {
		limit(`mail-sync:${uid}`, 6);
		const { accountId } = await body(event);
		const ids = all<{ id: string }>('SELECT id FROM accounts WHERE user_id=?', uid)
			.map((x) => x.id)
			.filter((x) => !accountId || x === accountId);
		const errors: string[] = [];
		await serialized(uid, async () => {
			for (const id of ids)
				try {
					await syncAccount(uid, id);
				} catch (e) {
					errors.push(e instanceof ApiError ? e.message : 'Sync failed');
				}
		});
		return json({ ...snapshot(uid), errors });
	}
	if (path === 'messages' && method === 'PATCH') {
		limit(`mail-action:${uid}`, 60);
		const input = await body(event);
		assert(typeof input.id === 'string', 'Missing message');
		const change: { read?: boolean; starred?: boolean; folder?: Folder } = {};
		if (typeof input.read === 'boolean') change.read = input.read;
		if (typeof input.starred === 'boolean') change.starred = input.starred;
		if (input.folder) {
			assert(['inbox', 'archive', 'trash'].includes(input.folder), 'Invalid destination');
			change.folder = input.folder;
		}
		await serialized(uid, () => updateMessage(uid, input.id, change));
		return json({ ok: true });
	}
	if (path === 'attachment' && method === 'GET') {
		limit(`attachment:${uid}`, 30);
		const file = await serialized(uid, () =>
			attachment(
				uid,
				event.url.searchParams.get('id') || '',
				Number(event.url.searchParams.get('index'))
			)
		);
		return new Response(new Uint8Array(file.content), {
			headers: {
				'content-type': 'application/octet-stream',
				'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename || 'attachment')}`,
				'x-content-type-options': 'nosniff'
			}
		});
	}
	if (path === 'drafts' && method === 'PUT') {
		const { draft } = await body(event);
		assert(
			draft &&
				typeof draft.id === 'string' &&
				draft.id.length <= 100 &&
				typeof draft.accountId === 'string',
			'Invalid draft'
		);
		for (const key of ['to', 'subject', 'text'])
			assert(
				typeof draft[key] === 'string' && draft[key].length <= (key === 'text' ? 200_000 : 2000),
				'Invalid draft'
			);
		assert(
			!draft.replyTo || (typeof draft.replyTo === 'string' && draft.replyTo.length <= 1000),
			'Invalid reply'
		);
		db.transaction(() => {
			assert(
				one('SELECT id FROM accounts WHERE id=? AND user_id=?', draft.accountId, uid),
				'Choose a connected account'
			);
			const existing = one<{ user_id: string; data: string }>(
				'SELECT user_id,data FROM drafts WHERE id=?',
				draft.id
			);
			assert(!existing || existing.user_id === uid, 'Invalid draft', 404);
			assert(
				existing ? JSON.parse(existing.data).updatedAt === draft.updatedAt : draft.updatedAt === '',
				'This draft changed on another device — your text is still here, copy it before reopening the latest draft',
				409
			);
			const clean: Draft = {
				id: draft.id,
				accountId: draft.accountId,
				to: draft.to,
				subject: draft.subject,
				text: draft.text,
				replyTo: draft.replyTo,
				updatedAt: new Date().toISOString()
			};
			db.query(
				'INSERT INTO drafts VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE user_id=excluded.user_id'
			).run(clean.id, uid, JSON.stringify(clean));
			bump(uid);
		})();
		return json(snapshot(uid));
	}
	if (path.startsWith('drafts/') && method === 'DELETE') {
		db.transaction(() => {
			db.query('DELETE FROM drafts WHERE id=? AND user_id=?').run(path.slice(7), uid);
			bump(uid);
		})();
		return json({ ok: true });
	}
	if (path === 'send' && method === 'POST') {
		limit(`send:${uid}`, 30, 3600_000);
		const form = await event.request.formData();
		let draft: Draft;
		try {
			draft = JSON.parse(String(form.get('draft')));
		} catch {
			throw new ApiError(400, 'Invalid message');
		}
		assert(
			draft &&
				['id', 'accountId', 'to', 'subject', 'text'].every(
					(x) => typeof (draft as unknown as Record<string, unknown>)[x] === 'string'
				),
			'Invalid message'
		);
		assert(
			draft.id.length <= 100 &&
				draft.accountId.length <= 100 &&
				(!draft.replyTo || (typeof draft.replyTo === 'string' && draft.replyTo.length <= 1000)),
			'Invalid message'
		);
		const requestId = String(form.get('requestId') || '');
		assert(/^[a-f0-9-]{36}$/.test(requestId), 'Missing delivery identifier');
		const uploads = form.getAll('files');
		assert(uploads.length <= 10, 'Attach up to 10 files');
		let size = 0;
		const files: { filename: string; content: Buffer }[] = [];
		for (const file of uploads) {
			assert(file instanceof File, 'Invalid attachment');
			size += file.size;
			assert(size <= 15 * 1024 * 1024, 'Attachments must total less than 15 MB', 413);
			files.push({ filename: file.name, content: Buffer.from(await file.arrayBuffer()) });
		}
		return json(await serialized(uid, () => send(uid, draft, files, `${requestId}`)));
	}
	throw new ApiError(404, 'Endpoint not found');
}
async function handle(event: RequestEvent) {
	try {
		if (event.request.body) {
			const maximum = event.request.headers.get('content-type')?.startsWith('multipart/form-data')
				? 16 * 1024 * 1024
				: 1024 * 1024;
			assert(
				Number(event.request.headers.get('content-length') || 0) <= maximum,
				'Request is too large',
				413
			);
			const reader = event.request.body.getReader();
			const chunks: Uint8Array[] = [];
			let length = 0;
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				length += value.length;
				if (length > maximum) {
					await reader.cancel();
					throw new ApiError(413, 'Request is too large');
				}
				chunks.push(value);
			}
			const data = new Uint8Array(length);
			let offset = 0;
			for (const chunk of chunks) {
				data.set(chunk, offset);
				offset += chunk.length;
			}
			event.request = new Request(event.request.url, {
				method: event.request.method,
				headers: event.request.headers,
				body: data
			});
		}
		const response = await dispatch(event);
		response.headers.set('cache-control', 'no-store');
		return response;
	} catch (error) {
		const status = error instanceof ApiError ? error.status : 500;
		const message =
			error instanceof ApiError ? error.message : 'The request could not be completed';
		if (event.params.path === 'auth/apple/callback')
			return new Response(null, {
				status: 303,
				headers: {
					location: `/?authError=${encodeURIComponent(message)}`,
					'cache-control': 'no-store'
				}
			});
		return json({ error: message }, { status, headers: { 'cache-control': 'no-store' } });
	}
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
