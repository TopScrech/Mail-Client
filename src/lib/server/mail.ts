import { ImapFlow, type FetchMessageObject } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { simpleParser } from 'mailparser';
import { parseMessageBody } from './message-body';
import { db, one, all, bump } from './db';
import { encrypt, decrypt } from './crypto';
import { allowedHosts, assert, string, ApiError } from './config';
import { refreshOAuth, type Credentials } from './mail-oauth';
import { isMailAuthError, MailAuthError } from './mail-errors';
import type { MailAccount, Message, Folder, Draft } from '$lib/types';
interface AccountRow {
	id: string;
	user_id: string;
	data: string;
	secret: string;
}
const now = () => new Date().toISOString();
const locks = new Map<string, Promise<unknown>>();
export async function serialized<T>(userId: string, action: () => Promise<T>): Promise<T> {
	const previous = locks.get(userId) || Promise.resolve();
	const next = previous.catch(() => {}).then(action);
	locks.set(userId, next);
	try {
		return await next;
	} finally {
		if (locks.get(userId) === next) locks.delete(userId);
	}
}
export function account(userId: string, id: string) {
	const row = one<AccountRow>('SELECT * FROM accounts WHERE id=? AND user_id=?', id, userId);
	assert(row, 'Mail account not found', 404);
	return {
		row,
		data: JSON.parse(row.data) as MailAccount,
		credentials: JSON.parse(decrypt(row.secret, `${userId}:${id}`)) as Credentials
	};
}
export function recordAuthFailure(userId: string, id: string, error: unknown) {
	if (!isMailAuthError(error)) return;
	const row = one<{ data: string }>(
		'SELECT data FROM accounts WHERE id=? AND user_id=?',
		id,
		userId
	);
	if (!row) return;
	const data: MailAccount = JSON.parse(row.data);
	data.reconnectRequired = true;
	data.error =
		'Authentication failed — reconnect this account to continue receiving and sending mail';
	db.transaction(() => {
		db.query('UPDATE accounts SET data=? WHERE id=? AND user_id=?').run(
			JSON.stringify(data),
			id,
			userId
		);
		bump(userId);
	})();
}
async function authorizedAccount(userId: string, id: string) {
	const result = account(userId, id);
	try {
		if (result.credentials.oauth) {
			const previous = result.credentials.oauth;
			result.credentials.oauth = await refreshOAuth(previous);
			if (result.credentials.oauth !== previous) {
				db.query('UPDATE accounts SET secret=? WHERE id=? AND user_id=?').run(
					encrypt(JSON.stringify(result.credentials), `${userId}:${id}`),
					id,
					userId
				);
			}
		}
	} catch (error) {
		recordAuthFailure(userId, id, error);
		throw error;
	}
	return result;
}
async function connectImap(client: ImapFlow, userId: string, id: string) {
	try {
		await client.connect();
	} catch (error) {
		recordAuthFailure(userId, id, error);
		if (isMailAuthError(error)) throw new MailAuthError();
		throw error;
	}
}
function validateHost(host: string) {
	assert(
		allowedHosts().includes(host.toLowerCase()),
		'This mail host is not enabled by the server operator'
	);
}
function imap(data: MailAccount, credentials: Credentials, idle = false) {
	validateHost(data.imapHost);
	const client = new ImapFlow({
		host: data.imapHost,
		port: 993,
		secure: true,
		auth: credentials.oauth
			? { user: credentials.username, accessToken: credentials.oauth.accessToken }
			: { user: credentials.username, pass: credentials.password! },
		logger: false,
		qresync: true,
		connectionTimeout: 15_000,
		greetingTimeout: 15_000,
		socketTimeout: idle ? 300_000 : 30_000,
		maxIdleTime: idle ? 240_000 : undefined,
		autoIdleDelay: idle ? 0 : undefined,
		tls: { rejectUnauthorized: true }
	});
	client.on('error', () => {});
	return client;
}
export async function idleClient(userId: string, id: string) {
	return serialized(userId, async () => {
		const { data, credentials } = await authorizedAccount(userId, id);
		return imap(data, credentials, true);
	});
}
function smtp(data: MailAccount, credentials: Credentials) {
	validateHost(data.smtpHost);
	return nodemailer.createTransport({
		host: data.smtpHost,
		port: data.smtpPort,
		secure: data.smtpPort === 465,
		requireTLS: true,
		auth: credentials.oauth
			? { type: 'OAuth2', user: credentials.username, accessToken: credentials.oauth.accessToken }
			: { user: credentials.username, pass: credentials.password! },
		tls: { rejectUnauthorized: true },
		connectionTimeout: 15_000,
		greetingTimeout: 15_000,
		socketTimeout: 30_000,
		disableFileAccess: true,
		disableUrlAccess: true
	});
}
export async function connectAccount(
	userId: string,
	input: Record<string, unknown>,
	oauthCredentials?: Credentials,
	reconnectId?: string
) {
	const existing = reconnectId
		? account(userId, reconnectId).row
		: oauthCredentials
			? all<{ id: string; data: string }>(
					'SELECT id,data FROM accounts WHERE user_id=?',
					userId
				).find(
					(row) => JSON.parse(row.data).email.toLowerCase() === String(input.email).toLowerCase()
				)
			: undefined;
	if (reconnectId) {
		assert(
			JSON.parse(existing!.data).email.toLowerCase() === String(input.email).toLowerCase(),
			'Reconnect using the same email address'
		);
	}
	const data: MailAccount = {
		id: existing?.id || crypto.randomUUID(),
		email: string(input.email, 'email address'),
		name: existing ? JSON.parse(existing.data).name : string(input.name, 'account name', 80),
		imapHost: string(input.imapHost, 'IMAP host').toLowerCase(),
		smtpHost: string(input.smtpHost, 'SMTP host').toLowerCase(),
		smtpPort: Number(input.smtpPort),
		lastSync: null,
		error: null,
		reconnectRequired: false
	};
	assert(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(data.email), 'Enter a valid email address');
	assert([465, 587].includes(data.smtpPort), 'Use SMTP port 465 or 587');
	assert(
		existing || all('SELECT id FROM accounts WHERE user_id=?', userId).length < 10,
		'A workspace supports up to 10 mail accounts'
	);
	validateHost(data.imapHost);
	validateHost(data.smtpHost);
	const credentials: Credentials = oauthCredentials || {
		username: string(
			input.username ||
				(reconnectId ? account(userId, reconnectId).credentials.username : input.email),
			'username'
		),
		password:
			typeof input.password === 'string' &&
			input.password.length > 0 &&
			input.password.length <= 1024
				? input.password
				: string(input.password, 'app password', 1024)
	};
	const secret = encrypt(JSON.stringify(credentials), `${userId}:${data.id}`);
	const client = imap(data, credentials);
	const transport = smtp(data, credentials);
	try {
		await client.connect();
		await transport.verify();
	} catch {
		throw new ApiError(
			422,
			oauthCredentials
				? 'Connection failed — ensure IMAP and authenticated SMTP are enabled for this mailbox'
				: 'Connection failed — check the servers, username, and app password'
		);
	} finally {
		await client.logout().catch(() => {});
		transport.close();
	}
	db.transaction(() => {
		db.query(
			'INSERT INTO accounts VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, secret=excluded.secret'
		).run(data.id, userId, JSON.stringify(data), secret);
		bump(userId);
	})();
	return data;
}
const special: Record<string, Folder> = {
	'\\Sent': 'sent',
	'\\Archive': 'archive',
	'\\Trash': 'trash'
};
const folderSpecial: Partial<Record<Folder, string>> = {
	sent: '\\Sent',
	archive: '\\Archive',
	trash: '\\Trash'
};
async function destination(client: ImapFlow, folder: Folder) {
	if (folder === 'inbox') return 'INBOX';
	const entry = (await client.list()).find((x) => x.specialUse === folderSpecial[folder]);
	assert(entry, `Your mail server does not expose a ${folder} folder`, 422);
	return entry.path;
}
interface FolderCheckpoint {
	uidValidity: string;
	modseq?: bigint;
}
const checkpoints = new WeakMap<ImapFlow, Map<string, FolderCheckpoint>>();

// Only metadata uses the IDLE connection — body jobs run independently
async function syncFolder(
	userId: string,
	id: string,
	client: ImapFlow,
	path: string,
	folder: Folder
) {
	const lock = await client.getMailboxLock(path);
	try {
		const mailbox = client.mailbox;
		assert(mailbox, 'Mailbox is not open', 502);
		const uidValidity = mailbox.uidValidity.toString();
		const highestAtStart = mailbox.highestModseq;
		let states = checkpoints.get(client);
		if (!states) checkpoints.set(client, (states = new Map()));
		const previous = states.get(path);
		const canDelta =
			client.enabled.has('CONDSTORE') &&
			!mailbox.noModseq &&
			previous?.uidValidity === uidValidity &&
			previous.modseq !== undefined &&
			highestAtStart !== undefined &&
			highestAtStart >= previous.modseq;
		const cached = new Map(
			all<{ data: string }>(
				'SELECT data FROM messages WHERE account_id=? AND user_id=?',
				id,
				userId
			)
				.map((row) => JSON.parse(row.data) as Message)
				.filter((message) => message.path === path && message.uidValidity === uidValidity)
				.map((message) => [message.uid, message])
		);
		// UID membership detects deletions and keeps the 50-message window bounded on every server
		const members = mailbox.exists
			? await client.fetchAll(`${Math.max(1, mailbox.exists - 49)}:*`, {
					uid: true,
					...(!canDelta ? { flags: true } : {})
				})
			: [];
		const missing = members.filter((header) => !cached.has(header.uid)).map((header) => header.uid);
		const envelopes = missing.length
			? await client.fetchAll(
					missing,
					{
						uid: true,
						flags: true,
						envelope: true,
						internalDate: true,
						size: true
					},
					{ uid: true }
				)
			: [];
		const newHeaders = new Map(envelopes.map((header) => [header.uid, header]));
		const known = members.filter((header) => cached.has(header.uid)).map((header) => header.uid);
		const changed =
			canDelta && known.length && highestAtStart !== previous.modseq
				? await client.fetchAll(
						known,
						{ uid: true, flags: true },
						{ uid: true, changedSince: previous.modseq }
					)
				: [];
		const flags = new Map(
			(canDelta ? changed : members).map((header) => [header.uid, header.flags])
		);
		const messages: Message[] = [];
		for (const member of members) {
			const header = newHeaders.get(member.uid);
			const old = cached.get(member.uid);
			if (!old && !header?.envelope) continue;
			const message = old ? { ...old } : fromHeader(id, path, folder, uidValidity, header!);
			const nextFlags = header?.flags || flags.get(member.uid);
			if (nextFlags) {
				message.read = nextFlags.has('\\Seen');
				message.starred = nextFlags.has('\\Flagged');
			}
			messages.push(message);
		}
		db.transaction(() => {
			const oldRows = all<{ id: string; data: string }>(
				folder === 'inbox'
					? "SELECT id,data FROM messages WHERE account_id=? AND user_id=? AND json_extract(data,'$.folder')=?"
					: "SELECT id,data FROM messages WHERE account_id=? AND user_id=? AND json_extract(data,'$.path')=?",
				id,
				userId,
				folder === 'inbox' ? 'inbox' : path
			);
			const ids = new Set(messages.map((message) => message.id));
			let dirty = false;
			for (const old of oldRows)
				if (!ids.has(old.id)) {
					db.query('DELETE FROM messages WHERE id=? AND user_id=?').run(old.id, userId);
					dirty = true;
				}
			for (const message of messages) {
				const current = one<{ data: string }>(
					'SELECT data FROM messages WHERE id=? AND user_id=?',
					message.id,
					userId
				);
				// A body may have finished while metadata was in flight — keep its latest content
				if (current) {
					const body: Message = JSON.parse(current.data);
					message.text = body.text;
					message.html = body.html;
					message.attachments = body.attachments;
				}
				const data = JSON.stringify(message);
				if (data !== current?.data) {
					db.query(
						'INSERT INTO messages VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'
					).run(message.id, userId, id, data);
					dirty = true;
				}
				if (message.html === undefined)
					db.query(
						'INSERT OR IGNORE INTO body_jobs (message_id,user_id,account_id,size) VALUES (?,?,?,?)'
					).run(message.id, userId, id, newHeaders.get(message.uid)?.size || 0);
			}
			if (dirty) bump(userId);
		})();
		// Store the starting watermark, never a later value that could skip an in-flight change
		states.set(path, { uidValidity, modseq: highestAtStart });
	} finally {
		lock.release();
	}
}

function fromHeader(
	id: string,
	path: string,
	folder: Folder,
	uidValidity: string,
	header: FetchMessageObject
): Message {
	const envelope = header.envelope!;
	return {
		id: `${id}:${encodeURIComponent(path)}:${uidValidity}:${header.uid}`,
		accountId: id,
		folder,
		path,
		uid: header.uid,
		uidValidity,
		from: envelope.from?.[0]?.name || envelope.from?.[0]?.address || 'Unknown sender',
		fromAddress: envelope.from?.[0]?.address || '',
		to: envelope.to?.map((x) => x.address).join(', ') || '',
		subject: envelope.subject || '(No subject)',
		text: '',
		date: envelope.date ? new Date(envelope.date).toISOString() : now(),
		read: header.flags?.has('\\Seen') || false,
		starred: header.flags?.has('\\Flagged') || false,
		messageId: envelope.messageId || '',
		attachments: []
	};
}

interface BodyJob {
	message_id: string;
	size: number;
	data: string;
}
function nextBodyJob(userId: string, id: string) {
	return one<BodyJob>(
		`SELECT j.message_id,j.size,m.data FROM body_jobs j JOIN messages m ON m.id=j.message_id
		WHERE j.user_id=? AND j.account_id=? AND j.next_attempt<=? AND j.message_id NOT IN (SELECT message_id FROM pending_moves)
		ORDER BY json_extract(m.data,'$.date') DESC LIMIT 1`,
		userId,
		id,
		Date.now()
	);
}
export function hasBodyJobs(userId: string, id: string) {
	return !!nextBodyJob(userId, id);
}

export async function downloadBodies(userId: string, id: string, signal: AbortSignal) {
	if (!hasBodyJobs(userId, id)) return;
	const { data, credentials, version } = await serialized(userId, async () => {
		const result = await authorizedAccount(userId, id);
		return {
			...result,
			version: one<{ secret: string }>(
				'SELECT secret FROM accounts WHERE id=? AND user_id=?',
				id,
				userId
			)!.secret
		};
	});
	signal.throwIfAborted();
	const client = imap(data, credentials);
	const abort = () => client.close();
	signal.addEventListener('abort', abort, { once: true });
	try {
		await client.connect();
		for (let count = 0; count < 25; count++) {
			signal.throwIfAborted();
			const owner = one<{ secret: string; data: string }>(
				'SELECT secret,data FROM accounts WHERE id=? AND user_id=?',
				id,
				userId
			);
			if (!owner || owner.secret !== version || JSON.parse(owner.data).reconnectRequired) break;
			const job = nextBodyJob(userId, id);
			if (!job) break;
			const original: Message = JSON.parse(job.data);
			let body: Pick<Message, 'text' | 'html' | 'attachments'> | undefined;
			if (original.html === undefined) {
				const lock = await client.getMailboxLock(original.path);
				try {
					if (client.mailbox && client.mailbox.uidValidity.toString() === original.uidValidity) {
						const metadata = job.size
							? undefined
							: await client.fetchOne(original.uid, { size: true }, { uid: true });
						const size = job.size || (metadata && metadata.size) || 0;
						if (size > 20 * 1024 * 1024)
							body = {
								text: 'This message is larger than 20 MB — open it in your provider’s client',
								html: null,
								attachments: []
							};
						else {
							const source = await client.fetchOne(original.uid, { source: true }, { uid: true });
							if (source && source.source) body = await parseMessageBody(source.source);
						}
					}
				} finally {
					lock.release();
				}
			}
			signal.throwIfAborted();
			db.transaction(() => {
				const account = one<{ secret: string; data: string }>(
					'SELECT secret,data FROM accounts WHERE id=? AND user_id=?',
					id,
					userId
				);
				if (!account || account.secret !== version || JSON.parse(account.data).reconnectRequired)
					return;
				const row = one<{ data: string }>(
					'SELECT data FROM messages WHERE id=? AND user_id=?',
					job.message_id,
					userId
				);
				if (
					row &&
					body &&
					!one('SELECT message_id FROM pending_moves WHERE message_id=?', job.message_id)
				) {
					const current: Message = JSON.parse(row.data);
					if (current.html === undefined) {
						db.query('UPDATE messages SET data=? WHERE id=? AND user_id=?').run(
							JSON.stringify({ ...current, ...body }),
							current.id,
							userId
						);
						bump(userId);
					}
				}
				db.query('DELETE FROM body_jobs WHERE message_id=? AND user_id=?').run(
					job.message_id,
					userId
				);
			})();
		}
	} catch (error) {
		const owner = one<{ secret: string }>(
			'SELECT secret FROM accounts WHERE id=? AND user_id=?',
			id,
			userId
		);
		if (!signal.aborted && owner?.secret === version) recordAuthFailure(userId, id, error);
		throw error;
	} finally {
		try {
			if (signal.aborted) client.close();
			else await client.logout().catch(() => client.close());
		} finally {
			signal.removeEventListener('abort', abort);
		}
	}
}

export async function syncInbox(userId: string, id: string, client: ImapFlow) {
	await syncFolder(userId, id, client, 'INBOX', 'inbox');
}

export async function syncAccount(userId: string, id: string) {
	const { data, credentials } = await authorizedAccount(userId, id);
	const client = imap(data, credentials);
	try {
		await connectImap(client, userId, data.id);
		const folders = (await client.list()).filter(
			(x) => x.path.toUpperCase() === 'INBOX' || special[x.specialUse || '']
		);
		// Publish the inbox before slower folders during reconciliation as well
		folders.sort(
			(a, b) => Number(b.path.toUpperCase() === 'INBOX') - Number(a.path.toUpperCase() === 'INBOX')
		);
		for (const folder of folders) {
			await syncFolder(
				userId,
				id,
				client,
				folder.path,
				folder.path.toUpperCase() === 'INBOX' ? 'inbox' : special[folder.specialUse!]
			);
		}
		db.transaction(() => {
			const latest = one<{ data: string }>(
				'SELECT data FROM accounts WHERE id=? AND user_id=?',
				id,
				userId
			);
			if (!latest) return;
			const current: MailAccount = JSON.parse(latest.data);
			current.lastSync = now();
			if (!current.reconnectRequired) current.error = null;
			const paths = new Set(folders.map((folder) => folder.path));
			for (const row of all<{ id: string; data: string }>(
				'SELECT id,data FROM messages WHERE account_id=? AND user_id=?',
				id,
				userId
			)) {
				if (!paths.has(JSON.parse(row.data).path))
					db.query('DELETE FROM messages WHERE id=? AND user_id=?').run(row.id, userId);
			}
			db.query('UPDATE accounts SET data=? WHERE id=? AND user_id=?').run(
				JSON.stringify(current),
				id,
				userId
			);
			bump(userId);
		})();
	} catch (error) {
		if (isMailAuthError(error)) throw new MailAuthError();
		data.error = 'Could not sync this account — check your connection or reconnect the account';
		db.transaction(() => {
			const latest = one<{ data: string }>(
				'SELECT data FROM accounts WHERE id=? AND user_id=?',
				id,
				userId
			);
			if (!latest) return;
			const current: MailAccount = JSON.parse(latest.data);
			if (!current.reconnectRequired) current.error = data.error;
			db.query('UPDATE accounts SET data=? WHERE id=? AND user_id=?').run(
				JSON.stringify(current),
				id,
				userId
			);
			bump(userId);
		})();
		throw new ApiError(502, data.error);
	} finally {
		await client.logout().catch(() => {});
	}
}
export function message(userId: string, id: string) {
	const row = one<{ data: string }>(
		'SELECT data FROM messages WHERE id=? AND user_id=?',
		id,
		userId
	);
	assert(row, 'Message not found', 404);
	return JSON.parse(row.data) as Message;
}
interface PendingMove {
	message_id: string;
	account_id: string;
	changes: string;
	message: string;
}
const moveWorkers = new Map<string, Promise<void>>();
export function queueMessageMove(
	userId: string,
	id: string,
	change: { read?: boolean; starred?: boolean; folder: Folder }
) {
	const mail = message(userId, id);
	db.transaction(() => {
		db.query('INSERT INTO pending_moves VALUES (?,?,?,?,?) ON CONFLICT(message_id) DO NOTHING').run(
			id,
			userId,
			mail.accountId,
			JSON.stringify(change),
			JSON.stringify(mail)
		);
		bump(userId);
	})();
}
export function processPendingMoves(userId: string): Promise<void> {
	const running = moveWorkers.get(userId);
	if (running) return running;
	const worker = serialized(userId, async () => {
		let move: PendingMove | null;
		while (
			(move = one<PendingMove>(
				'SELECT * FROM pending_moves WHERE user_id=? ORDER BY rowid LIMIT 1',
				userId
			))
		) {
			try {
				await updateMessage(
					userId,
					move.message_id,
					JSON.parse(move.changes),
					JSON.parse(move.message)
				);
			} catch (error) {
				const row = one<{ data: string }>(
					'SELECT data FROM accounts WHERE id=? AND user_id=?',
					move.account_id,
					userId
				);
				if (row) {
					const data: MailAccount = JSON.parse(row.data);
					if (!data.reconnectRequired) {
						data.error = 'A message could not be moved — it was restored, try again';
					}
					db.transaction(() => {
						db.query('INSERT INTO messages VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING').run(
							move!.message_id,
							userId,
							move!.account_id,
							move!.message
						);
						db.query('UPDATE accounts SET data=? WHERE id=? AND user_id=?').run(
							JSON.stringify(data),
							move!.account_id,
							userId
						);
					})();
				}
			} finally {
				db.transaction(() => {
					db.query('DELETE FROM pending_moves WHERE message_id=? AND user_id=?').run(
						move!.message_id,
						userId
					);
					bump(userId);
				})();
			}
		}
	}).finally(() => {
		if (moveWorkers.get(userId) === worker) moveWorkers.delete(userId);
	});
	moveWorkers.set(userId, worker);
	return worker;
}
export async function updateMessage(
	userId: string,
	id: string,
	change: { read?: boolean; starred?: boolean; folder?: Folder },
	original?: Message
) {
	const mail = original || message(userId, id);
	const { data, credentials } = await authorizedAccount(userId, mail.accountId);
	const client = imap(data, credentials);
	try {
		await connectImap(client, userId, data.id);
		const target = change.folder ? await destination(client, change.folder) : null;
		let moved: Message | undefined;
		const lock = await client.getMailboxLock(mail.path);
		try {
			assert(
				client.mailbox && client.mailbox.uidValidity.toString() === mail.uidValidity,
				'Mailbox changed — sync and try again',
				409
			);
			const flags = async (flag: string, enabled: boolean) => {
				if (enabled) await client.messageFlagsAdd(mail.uid, [flag], { uid: true });
				else await client.messageFlagsRemove(mail.uid, [flag], { uid: true });
			};
			if (typeof change.read === 'boolean') await flags('\\Seen', change.read);
			if (typeof change.starred === 'boolean') await flags('\\Flagged', change.starred);
			if (target && target !== mail.path) {
				const result = await client.messageMove(mail.uid, target, { uid: true });
				assert(result, 'Message could not be moved — sync and try again', 409);
				const uid = result.uidMap?.get(mail.uid);
				if (uid && result.uidValidity) {
					const uidValidity = result.uidValidity.toString();
					moved = {
						...mail,
						...change,
						folder: change.folder!,
						path: target,
						uid,
						uidValidity,
						id: `${mail.accountId}:${encodeURIComponent(target)}:${uidValidity}:${uid}`
					};
				}
			}
		} finally {
			lock.release();
		}
		db.transaction(() => {
			const latest = one<{ data: string }>(
				'SELECT data FROM messages WHERE id=? AND user_id=?',
				id,
				userId
			);
			const current: Message = latest ? JSON.parse(latest.data) : mail;
			if (target && target !== mail.path) {
				db.query('DELETE FROM messages WHERE id=? AND user_id=?').run(id, userId);
				if (moved) {
					moved = {
						...moved,
						text: current.text,
						html: current.html,
						attachments: current.attachments
					};
					db.query(
						'INSERT INTO messages VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'
					).run(moved.id, userId, moved.accountId, JSON.stringify(moved));
					if (moved.html === undefined)
						db.query(
							'INSERT OR IGNORE INTO body_jobs (message_id,user_id,account_id,size) VALUES (?,?,?,0)'
						).run(moved.id, userId, moved.accountId);
				}
			} else
				db.query('UPDATE messages SET data=? WHERE id=? AND user_id=?').run(
					JSON.stringify({ ...current, ...change }),
					id,
					userId
				);
			bump(userId);
		})();
	} finally {
		await client.logout().catch(() => {});
	}
}
export async function attachment(userId: string, id: string, index: number) {
	const mail = message(userId, id);
	assert(
		mail.attachments.some((x) => x.index === index),
		'Attachment not found',
		404
	);
	const { data, credentials } = await authorizedAccount(userId, mail.accountId);
	const client = imap(data, credentials);
	try {
		await connectImap(client, userId, data.id);
		const lock = await client.getMailboxLock(mail.path);
		try {
			assert(
				client.mailbox && client.mailbox.uidValidity.toString() === mail.uidValidity,
				'Mailbox changed — sync and try again',
				409
			);
			const metadata = await client.fetchOne(mail.uid, { size: true }, { uid: true });
			assert(
				metadata && metadata.size && metadata.size <= 20 * 1024 * 1024,
				'Attachment exceeds the 20 MB download limit',
				413
			);
			const source = await client.fetchOne(mail.uid, { source: true }, { uid: true });
			assert(source && source.source, 'Message no longer exists', 404);
			const parsed = await simpleParser(source.source);
			const file = parsed.attachments[index];
			assert(file, 'Attachment not found', 404);
			return file;
		} finally {
			lock.release();
		}
	} finally {
		await client.logout().catch(() => {});
	}
}
export async function send(
	userId: string,
	draft: Draft,
	files: { filename: string; content: Buffer }[],
	requestId: string
) {
	const old = one<{ state: string }>(
		'SELECT state FROM sends WHERE id=? AND user_id=?',
		requestId,
		userId
	);
	if (old?.state === 'sent') return { ok: true };
	assert(!old, 'Delivery is already in progress or uncertain — check Sent before retrying', 409);
	const { data, credentials } = await authorizedAccount(userId, draft.accountId);
	assert(
		draft.to.length <= 2000 &&
			draft.to.split(',').every((x) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(x.trim())),
		'Enter recipient email addresses separated by commas'
	);
	assert(draft.subject.length <= 500 && draft.text.length <= 200_000, 'Message is too long');
	db.query('INSERT INTO sends VALUES (?,?,?,?)').run(
		requestId,
		userId,
		'pending',
		Date.now() + 7 * 86400_000
	);
	const raw = await new MailComposer({
		from: { name: data.name, address: data.email },
		to: draft.to,
		subject: draft.subject,
		text: draft.text,
		inReplyTo: draft.replyTo,
		references: draft.replyTo,
		attachments: files,
		disableFileAccess: true,
		disableUrlAccess: true
	})
		.compile()
		.build();
	const transport = smtp(data, credentials);
	try {
		const result = await transport.sendMail({
			envelope: { from: data.email, to: draft.to.split(',').map((x) => x.trim()) },
			raw
		});
		assert(result.accepted?.length > 0, 'No recipients accepted this message', 422);
		db.transaction(() => {
			db.query('UPDATE sends SET state=? WHERE id=? AND user_id=?').run('sent', requestId, userId);
			db.query('DELETE FROM drafts WHERE id=? AND user_id=?').run(draft.id, userId);
			bump(userId);
		})();
		// Gmail and some providers save sent messages themselves; other providers need an IMAP append
		let sentCopyWarning: string | undefined;
		if (data.smtpHost !== 'smtp.gmail.com' && process.env.SMTP_SAVES_SENT !== 'true') {
			const client = imap(data, credentials);
			try {
				await connectImap(client, userId, data.id);
				const path = await destination(client, 'sent');
				await client.append(path, raw, ['\\Seen']);
			} catch {
				sentCopyWarning = 'Message sent, but a copy could not be saved to Sent';
			} finally {
				await client.logout().catch(() => {});
			}
		}
		return {
			ok: true,
			warning: result.rejected?.length
				? `Not delivered to: ${result.rejected.join(', ')}`
				: sentCopyWarning
		};
	} catch (error) {
		if (isMailAuthError(error)) {
			recordAuthFailure(userId, data.id, error);
			db.query('DELETE FROM sends WHERE id=? AND user_id=? AND state=?').run(
				requestId,
				userId,
				'pending'
			);
			throw new MailAuthError();
		}
		if (error instanceof ApiError) throw error;
		throw new ApiError(502, 'Delivery could not be confirmed — check Sent before trying again');
	} finally {
		transport.close();
	}
}
