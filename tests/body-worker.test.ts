import { afterEach, expect, test } from 'bun:test';
import { BodyWorker } from '../src/lib/server/body-worker';
import type { WatchedAccount } from '../src/lib/server/mail-worker';

const workers: BodyWorker[] = [];
afterEach(() => {
	for (const worker of workers.splice(0)) worker.stop();
});
async function until(condition: () => boolean) {
	for (let attempt = 0; !condition() && attempt < 200; attempt++) await Bun.sleep(2);
	expect(condition()).toBe(true);
}
const account = (id: string): WatchedAccount => ({ id, userId: 'alice', version: '1' });

test('limits concurrent body connections and continues other accounts when one download stalls', async () => {
	const accounts = ['a', 'b', 'c'].map(account);
	const pending = new Set(['a', 'b', 'c']);
	const releases = new Map<string, () => void>();
	const worker = new BodyWorker(
		{
			accounts: () => accounts,
			hasJobs: (account) => pending.has(account.id),
			download: async (account, signal) => {
				await new Promise<void>((resolve) => {
					releases.set(account.id, resolve);
					signal.addEventListener('abort', () => resolve(), { once: true });
				});
				pending.delete(account.id);
			},
			failed() {
				throw new Error('Unexpected failure');
			}
		},
		2,
		5
	);
	workers.push(worker);
	worker.start();
	expect([...releases.keys()]).toEqual(['a', 'b']);
	releases.get('b')!();
	await until(() => releases.has('c'));
	expect(pending.has('a')).toBe(true);
});

test('credential replacement and account removal cancel the old body connection', async () => {
	const accounts = [account('a')];
	const signals: AbortSignal[] = [];
	const worker = new BodyWorker(
		{
			accounts: () => accounts,
			hasJobs: () => true,
			download: async (_, signal) => {
				signals.push(signal);
				await new Promise<void>((resolve) =>
					signal.addEventListener('abort', () => resolve(), { once: true })
				);
			},
			failed() {}
		},
		2,
		5
	);
	workers.push(worker);
	worker.start();
	accounts[0] = { ...accounts[0], version: '2' };
	worker.scan();
	await until(() => signals.length === 2);
	expect(signals[0].aborted).toBe(true);
	accounts.splice(0);
	worker.scan();
	expect(signals[1].aborted).toBe(true);
});

test('failed downloads retry without an immediate loop and a new worker resumes pending work', async () => {
	let pending = true;
	let attempts = 0;
	let failures = 0;
	const deps = {
		accounts: () => [account('a')],
		hasJobs: () => pending,
		async download() {
			attempts++;
			throw new Error('Temporary provider failure');
		},
		failed() {
			failures++;
		}
	};
	const first = new BodyWorker(deps, 2, 15);
	workers.push(first);
	first.start();
	await until(() => failures === 1);
	expect(attempts).toBe(1);
	first.stop();
	const resumed = new BodyWorker(
		{
			...deps,
			async download() {
				attempts++;
				pending = false;
			}
		},
		2,
		5
	);
	workers.push(resumed);
	resumed.start();
	await until(() => !pending);
	expect(attempts).toBe(2);
});
