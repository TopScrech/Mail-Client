import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { simpleParser } from 'mailparser';
import { db, one, all, bump } from './db';
import { encrypt, decrypt } from './crypto';
import { allowedHosts, assert, string, ApiError } from './config';
import { refreshOAuth, type Credentials } from './mail-oauth';
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
async function authorizedAccount(userId: string, id: string) {
	const result = account(userId, id);
	if (result.credentials.oauth) {
		result.credentials.oauth = await refreshOAuth(result.credentials.oauth);
		db.query('UPDATE accounts SET secret=? WHERE id=? AND user_id=?').run(
			encrypt(JSON.stringify(result.credentials), `${userId}:${id}`),
			id,
			userId
		);
	}
	return result;
}
function validateHost(host: string) {
	assert(
		allowedHosts().includes(host.toLowerCase()),
		'This mail host is not enabled by the server operator'
	);
}
function imap(data: MailAccount, credentials: Credentials) {
	validateHost(data.imapHost);
	const client = new ImapFlow({
		host: data.imapHost,
		port: 993,
		secure: true,
		auth: credentials.oauth
			? { user: credentials.username, accessToken: credentials.oauth.accessToken }
			: { user: credentials.username, pass: credentials.password! },
		logger: false,
		connectionTimeout: 15_000,
		greetingTimeout: 15_000,
		socketTimeout: 30_000,
		tls: { rejectUnauthorized: true }
	});
	client.on('error', () => {});
	return client;
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
	oauthCredentials?: Credentials
) {
	const existing = oauthCredentials
		? all<{ id: string; data: string }>(
				'SELECT id,data FROM accounts WHERE user_id=?',
				userId
			).find(
				(row) => JSON.parse(row.data).email.toLowerCase() === String(input.email).toLowerCase()
			)
		: undefined;
	const data: MailAccount = {
		id: existing?.id || crypto.randomUUID(),
		email: string(input.email, 'email address'),
		name: existing ? JSON.parse(existing.data).name : string(input.name, 'account name', 80),
		imapHost: string(input.imapHost, 'IMAP host').toLowerCase(),
		smtpHost: string(input.smtpHost, 'SMTP host').toLowerCase(),
		smtpPort: Number(input.smtpPort),
		lastSync: null,
		error: null
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
		username: string(input.username || input.email, 'username'),
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
export async function syncAccount(userId: string, id: string) {
	const { data, credentials } = await authorizedAccount(userId, id);
	const client = imap(data, credentials);
	const messages: Message[] = [];
	try {
		await client.connect();
		const folders = (await client.list()).filter(
			(x) => x.path.toUpperCase() === 'INBOX' || special[x.specialUse || '']
		);
		for (const folder of folders) {
			const lock = await client.getMailboxLock(folder.path);
			try {
				const mailbox = client.mailbox;
				if (!mailbox || !mailbox.exists) continue;
				const first = Math.max(1, mailbox.exists - 49);
				const headers = await client.fetchAll(`${first}:*`, {
					uid: true,
					flags: true,
					envelope: true,
					internalDate: true,
					size: true
				});
				for (const header of headers) {
					if (!header.envelope) continue;
					const envelope = header.envelope;
					const uidValidity = mailbox.uidValidity.toString();
					const messageId = `${id}:${encodeURIComponent(folder.path)}:${uidValidity}:${header.uid}`;
					const existing = one<{ data: string }>(
						'SELECT data FROM messages WHERE id=? AND user_id=?',
						messageId,
						userId
					);
					let text = '';
					let attachments: Message['attachments'] = [];
					if (existing) {
						const cached: Message = JSON.parse(existing.data);
						text = cached.text;
						attachments = cached.attachments;
					} else if ((header.size || 0) <= 20 * 1024 * 1024) {
						const source = await client.fetchOne(header.uid, { source: true }, { uid: true });
						if (source && source.source) {
							const parsed = await simpleParser(source.source, {
								skipHtmlToText: false,
								skipTextToHtml: true
							});
							text = (parsed.text || '').slice(0, 200_000);
							attachments = parsed.attachments.map((x, index) => ({
								index,
								filename: x.filename || 'Attachment',
								size: x.size
							}));
						}
					} else text = 'This message is larger than 20 MB — open it in your provider’s client';
					messages.push({
						id: messageId,
						accountId: id,
						folder: folder.path.toUpperCase() === 'INBOX' ? 'inbox' : special[folder.specialUse!],
						path: folder.path,
						uid: header.uid,
						uidValidity,
						from: envelope.from?.[0]?.name || envelope.from?.[0]?.address || 'Unknown sender',
						fromAddress: envelope.from?.[0]?.address || '',
						to: envelope.to?.map((x) => x.address).join(', ') || '',
						subject: envelope.subject || '(No subject)',
						text,
						date: envelope.date?.toISOString() || now(),
						read: header.flags?.has('\\Seen') || false,
						starred: header.flags?.has('\\Flagged') || false,
						messageId: envelope.messageId || '',
						attachments
					});
				}
			} finally {
				lock.release();
			}
		}
		data.lastSync = now();
		data.error = null;
		db.transaction(() => {
			db.query('DELETE FROM messages WHERE account_id=? AND user_id=?').run(id, userId);
			const insert = db.query('INSERT INTO messages VALUES (?,?,?,?)');
			for (const message of messages) insert.run(message.id, userId, id, JSON.stringify(message));
			db.query('UPDATE accounts SET data=? WHERE id=? AND user_id=?').run(
				JSON.stringify(data),
				id,
				userId
			);
			bump(userId);
		})();
	} catch {
		data.error = 'Could not sync this account — check your connection or reconnect the account';
		db.transaction(() => {
			db.query('UPDATE accounts SET data=? WHERE id=? AND user_id=?').run(
				JSON.stringify(data),
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
export async function updateMessage(
	userId: string,
	id: string,
	change: { read?: boolean; starred?: boolean; folder?: Folder }
) {
	const mail = message(userId, id);
	const { data, credentials } = await authorizedAccount(userId, mail.accountId);
	const client = imap(data, credentials);
	try {
		await client.connect();
		const target = change.folder ? await destination(client, change.folder) : null;
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
			if (target && target !== mail.path) await client.messageMove(mail.uid, target, { uid: true });
		} finally {
			lock.release();
		}
		db.transaction(() => {
			if (target && target !== mail.path)
				db.query('DELETE FROM messages WHERE id=? AND user_id=?').run(id, userId);
			else
				db.query('UPDATE messages SET data=? WHERE id=? AND user_id=?').run(
					JSON.stringify({ ...mail, ...change }),
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
		await client.connect();
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
				await client.connect();
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
		if (error instanceof ApiError) throw error;
		throw new ApiError(502, 'Delivery could not be confirmed — check Sent before trying again');
	} finally {
		transport.close();
	}
}
