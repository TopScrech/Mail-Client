import { all } from './db';
import { subscribeChanges } from './events';
import { MailWorker } from './mail-worker';
import {
	idleClient,
	processPendingMoves,
	recordAuthFailure,
	serialized,
	syncAccount
} from './mail';

export function startMailWorker() {
	const worker = new MailWorker({
		accounts() {
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
		},
		client: (account) => idleClient(account.userId, account.id),
		async sync(account) {
			await processPendingMoves(account.userId);
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
				await syncAccount(account.userId, account.id);
			});
		},
		failed: (account, error) => recordAuthFailure(account.userId, account.id, error)
	});
	const unsubscribe = subscribeChanges(() => worker.scan());
	worker.start();
	return () => {
		unsubscribe();
		worker.stop();
	};
}
