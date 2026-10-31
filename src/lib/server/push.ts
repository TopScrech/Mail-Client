import { connect } from 'node:http2';
import { createHash } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import { all, db, one } from './db';
import { assert } from './config';
import type { Session } from './auth';
import type { Message } from '$lib/types';
import { websiteIconDomains } from './sender-icons';

export function pushCredentials() {
	return {
		teamId: process.env.APNS_TEAM_ID || process.env.APPLE_TEAM_ID,
		keyId: process.env.APNS_KEY_ID || process.env.APPLE_KEY_ID,
		privateKey: process.env.APNS_PRIVATE_KEY || process.env.APPLE_PRIVATE_KEY
	};
}

export function pushConfigured() {
	return Object.values(pushCredentials()).every(Boolean) && !!process.env.APNS_TOPIC;
}

function deviceInput(input: unknown) {
	assert(input && typeof input === 'object', 'Invalid push registration');
	const { token, environment } = input as Record<string, unknown>;
	assert(
		typeof token === 'string' && /^[a-fA-F0-9]{32,512}$/.test(token) && token.length % 2 === 0,
		'Invalid device token'
	);
	assert(environment === 'development' || environment === 'production', 'Invalid APNs environment');
	return { token: token.toLowerCase(), environment };
}

export function registerPushDevice(session: Session, input: unknown) {
	assert(pushConfigured(), 'Push notifications are not configured on the server', 503);
	const { token, environment } = deviceInput(input);
	// Replace ownership and pending jobs when the same installation changes sessions
	const old = one<{ id: string; session_id: string }>(
		'SELECT id,session_id FROM push_devices WHERE token=? AND environment=?',
		token,
		environment
	);
	db.transaction(() => {
		if (old && old.session_id !== session.id)
			db.query('DELETE FROM push_devices WHERE id=?').run(old.id);
		db.query(
			`INSERT INTO push_devices VALUES (?,?,?,?,?) ON CONFLICT(token,environment) DO UPDATE SET updated_at=excluded.updated_at`
		).run(crypto.randomUUID(), session.id, token, environment, Date.now());
	})();
	return { ok: true };
}

export function unregisterPushDevice(session: Session, input: unknown) {
	const { token, environment } = deviceInput(input);
	db.query('DELETE FROM push_devices WHERE token=? AND environment=? AND session_id=?').run(
		token,
		environment,
		session.id
	);
}

// Called inside the mailbox transaction so the watermark and jobs commit together
export function queueInboxPushes(
	userId: string,
	accountId: string,
	validity: string,
	messages: Message[]
) {
	const previous = one<{ validity: string; uid: number }>(
		'SELECT * FROM push_checkpoints WHERE account_id=?',
		accountId
	);
	const maximum = Math.max(0, ...messages.map((message) => message.uid));
	if (previous?.validity === validity) {
		const devices = all<{ id: string }>(
			`SELECT d.id FROM push_devices d JOIN sessions s ON s.id=d.session_id WHERE s.user_id=? AND s.expires>?`,
			userId,
			Date.now()
		);
		for (const message of messages) {
			if (message.uid <= previous.uid || message.read || message.folder !== 'inbox') continue;
			for (const device of devices)
				db.query(
					'INSERT OR IGNORE INTO push_jobs (device_id,message_id,created_at) VALUES (?,?,?)'
				).run(device.id, message.id, Date.now());
		}
	}
	// First sync and UIDVALIDITY resets establish a baseline without alerting for old mail
	db.query(
		`INSERT INTO push_checkpoints VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET validity=excluded.validity,uid=excluded.uid`
	).run(
		accountId,
		validity,
		previous?.validity === validity ? Math.max(previous.uid, maximum) : maximum
	);
}

let providerToken: { value: string; expires: number } | undefined;
async function authorization() {
	if (providerToken && providerToken.expires > Date.now()) return providerToken.value;
	const credentials = pushCredentials();
	const key = await importPKCS8(credentials.privateKey!.replace(/\\n/g, '\n'), 'ES256');
	const value = await new SignJWT({})
		.setProtectedHeader({ alg: 'ES256', kid: credentials.keyId! })
		.setIssuer(credentials.teamId!)
		.setIssuedAt()
		.sign(key);
	providerToken = { value, expires: Date.now() + 50 * 60_000 };
	return value;
}

interface PushJob {
	id: number;
	device_id: string;
	token: string;
	environment: string;
	updated_at: number;
	attempts: number;
	data: string;
}
export interface PushResult {
	status: number;
	reason?: string;
	timestamp?: number;
}
function notificationSender(message: Message): string {
	const name = message.from.trim();
	if (name && !name.includes('@')) return name;
	// Some senders include the mailbox in their display name
	const displayName = name.match(/^"?([^<]+?)"?\s*<[^>]+>$/)?.[1]?.trim();
	if (displayName && !displayName.includes('@')) return displayName;
	const address = message.fromAddress.trim() || name;
	const localPart = address
		.split('@')[0]
		.replace(/[._-]+/g, ' ')
		.trim();
	return localPart || 'Unknown sender';
}

export function notificationPayload(message: Message) {
	return {
		aps: {
			category: 'MAIL_MESSAGE',
			'mutable-content': 1,
			alert: {
				title: notificationSender(message).slice(0, 160),
				body: message.subject.slice(0, 240)
			},
			sound: 'default',
			'thread-id': message.accountId
		},
		messageId: message.id,
		sender: {
			name: notificationSender(message).slice(0, 160),
			address: message.fromAddress.trim().slice(0, 320),
			websiteIconDomains: websiteIconDomains(message.fromAddress)
		}
	};
}

export async function sendPush(job: PushJob): Promise<PushResult> {
	const auth = await authorization();
	if (
		!one(
			`SELECT d.id FROM push_devices d JOIN sessions s ON s.id=d.session_id JOIN push_jobs j ON j.device_id=d.id WHERE j.id=? AND d.id=? AND s.expires>?`,
			job.id,
			job.device_id,
			Date.now()
		)
	)
		return { status: 200 };
	const message: Message = JSON.parse(job.data);
	const payload = JSON.stringify(notificationPayload(message));
	return new Promise((resolve, reject) => {
		const client = connect(
			job.environment === 'production'
				? 'https://api.push.apple.com'
				: 'https://api.sandbox.push.apple.com'
		);
		const timer = setTimeout(() => {
			client.destroy();
			reject(new Error('APNs timeout'));
		}, 15_000);
		const finish = () => {
			clearTimeout(timer);
			client.close();
		};
		client.on('error', (error) => {
			finish();
			reject(error);
		});
		const request = client.request({
			':method': 'POST',
			':path': `/3/device/${job.token}`,
			authorization: `bearer ${auth}`,
			'apns-topic': process.env.APNS_TOPIC!,
			'apns-push-type': 'alert',
			'apns-priority': '10',
			'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
			'apns-collapse-id': createHash('sha256').update(message.id).digest('hex')
		});
		let status = 0;
		let body = '';
		request.on('response', (headers) => {
			status = Number(headers[':status']);
		});
		request.setEncoding('utf8');
		request.on('data', (chunk) => {
			body += chunk;
		});
		request.on('error', (error) => {
			finish();
			reject(error);
		});
		request.on('end', () => {
			finish();
			try {
				resolve({ ...JSON.parse(body || '{}'), status });
			} catch {
				reject(new Error('Invalid APNs response'));
			}
		});
		request.end(payload);
	});
}

export async function deliverPushes(send: (job: PushJob) => Promise<PushResult> = sendPush) {
	db.query('DELETE FROM push_jobs WHERE created_at<?').run(Date.now() - 3600_000);
	const jobs = all<PushJob>(
		`SELECT j.*,d.token,d.environment,d.updated_at,m.data FROM push_jobs j JOIN push_devices d ON d.id=j.device_id JOIN sessions s ON s.id=d.session_id JOIN messages m ON m.id=j.message_id WHERE j.next_attempt<=? AND s.expires>? LIMIT 50`,
		Date.now(),
		Date.now()
	);
	for (const queued of jobs) {
		// Re-read after each awaited delivery to honor revocation and read/trash changes
		const job = one<PushJob>(
			`SELECT j.*,d.token,d.environment,d.updated_at,m.data FROM push_jobs j JOIN push_devices d ON d.id=j.device_id JOIN sessions s ON s.id=d.session_id JOIN messages m ON m.id=j.message_id WHERE j.id=? AND s.expires>?`,
			queued.id,
			Date.now()
		);
		if (!job) continue;
		const message: Message = JSON.parse(job.data);
		if (
			message.read ||
			message.folder !== 'inbox' ||
			one('SELECT message_id FROM pending_moves WHERE message_id=?', message.id)
		) {
			db.query('DELETE FROM push_jobs WHERE id=?').run(job.id);
			continue;
		}
		let result: PushResult;
		try {
			result = await send(job);
		} catch {
			result = { status: 0, reason: 'TransportError' };
		}
		if (result.status === 200) db.query('DELETE FROM push_jobs WHERE id=?').run(job.id);
		else if (
			['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(result.reason || '')
		) {
			db.query('DELETE FROM push_devices WHERE id=? AND updated_at<=?').run(
				job.device_id,
				result.timestamp ?? job.updated_at
			);
			db.query('DELETE FROM push_jobs WHERE id=?').run(job.id);
		} else {
			if (result.reason === 'ExpiredProviderToken') providerToken = undefined;
			console.warn('APNs delivery failed', {
				status: result.status,
				reason: result.reason,
				attempt: job.attempts + 1
			});
			db.query('UPDATE push_jobs SET attempts=attempts+1,next_attempt=? WHERE id=?').run(
				Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(job.attempts, 6)),
				job.id
			);
		}
	}
}

export function startPushWorker() {
	let busy = false;
	const timer = setInterval(async () => {
		if (busy || !pushConfigured()) return;
		busy = true;
		try {
			await deliverPushes();
		} catch {
			console.error('APNs queue processing failed');
		} finally {
			busy = false;
		}
	}, 5000);
	timer.unref?.();
	return () => clearInterval(timer);
}
