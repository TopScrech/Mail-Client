import { all, db, one } from './db';
import { subscribeChanges } from './events';
import { MailWorker } from './mail-worker';
import { BodyWorker } from './body-worker';
import {
	idleClient,
	processPendingMoves,
	recordAuthFailure,
	serialized,
	syncAccount,
	syncInbox,
	downloadBodies,
	hasBodyJobs
} from './mail';

export function startMailWorker() {
	function accounts() {
		const rows = all<{ id: string; user_id: string; secret: string; data: string }>(
			'SELECT * FROM accounts'
		);
		return rows
			.filter((row) => !JSON.parse(row.data).reconnectRequired)
			.map((row) => ({
				id: row.id,
				userId: row.user_id,
				version: row.secret
			}));
	}
	const bodies = new BodyWorker({
		accounts,
		hasJobs: (account) => hasBodyJobs(account.userId, account.id),
		download: (account, signal) => downloadBodies(account.userId, account.id, signal),
		failed(account) {
			const row = one<{ secret: string }>(
				'SELECT secret FROM accounts WHERE id=? AND user_id=?',
				account.id,
				account.userId
			);
			if (row?.secret !== account.version) return;
			db.query(
				`UPDATE body_jobs SET next_attempt=? + MIN(60000, 1000 * (1 << MIN(attempts, 6))), attempts=attempts+1
				WHERE account_id=? AND user_id=? AND next_attempt<=?`
			).run(Date.now(), account.id, account.userId, Date.now());
		}
	});
	const worker = new MailWorker({
		accounts,
		client: (account) => idleClient(account.userId, account.id),
		async sync(account, request) {
			if (request.reconcile) await processPendingMoves(account.userId);
			await serialized(account.userId, async () => {
				// A queued job may outlive a disconnect or credential replacement
				const current = all<{ secret: string; data: string }>(
					'SELECT secret,data FROM accounts WHERE id=? AND user_id=?',
					account.id,
					account.userId
				)[0];
				if (
					!current ||
					current.secret !== account.version ||
					JSON.parse(current.data).reconnectRequired
				)
					return;
				if (!request.reconcile && request.client) {
					await syncInbox(account.userId, account.id, request.client);
				} else {
					await syncAccount(account.userId, account.id);
				}
			});
		},
		failed: (account, error) => recordAuthFailure(account.userId, account.id, error)
	});
	const unsubscribe = subscribeChanges(() => {
		worker.scan();
		bodies.scan();
	});
	worker.start();
	bodies.start();
	return () => {
		unsubscribe();
		worker.stop();
		bodies.stop();
	};
}
