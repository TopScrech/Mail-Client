import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { MailWorker, type WatchedAccount } from '../src/lib/server/mail-worker';

class FakeClient extends EventEmitter {
	closed = false;
	selected = '';
	async connect() {}
	async mailboxOpen(path: string) {
		this.selected = path;
	}
	close() {
		if (!this.closed) {
			this.closed = true;
			this.emit('close');
		}
	}
}

async function until(condition: () => boolean) {
	const deadline = Date.now() + 1000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for worker');
		await Bun.sleep(2);
	}
}

const workers: MailWorker[] = [];
afterEach(() => {
	for (const worker of workers.splice(0)) worker.stop();
});

function setup(sync: (account: WatchedAccount) => Promise<void> = async () => {}) {
	const accounts: WatchedAccount[] = [{ id: 'a', userId: 'alice', version: 'credentials-1' }];
	const clients: FakeClient[] = [];
	let syncs = 0;
	const worker = new MailWorker(
		{
			accounts: () => accounts,
			async client() {
				const client = new FakeClient();
				clients.push(client);
				return client;
			},
			async sync(account) {
				syncs++;
				await sync(account);
			},
			failed() {}
		},
		{ scan: 5, reconcile: 60_000, debounce: 5, retry: 5, maxRetry: 20 }
	);
	workers.push(worker);
	return { worker, accounts, clients, syncs: () => syncs };
}

describe('Background mail synchronization', () => {
	test('selects INBOX, syncs without a browser, and coalesces notification bursts', async () => {
		const state = setup();
		state.worker.start();
		await until(() => state.syncs() === 1);
		expect(state.clients[0].selected).toBe('INBOX');
		for (const event of ['exists', 'flags', 'expunge', 'exists']) state.clients[0].emit(event);
		await until(() => state.syncs() === 2);
		await Bun.sleep(15);
		expect(state.syncs()).toBe(2);
	});

	test('serializes bursts and performs a trailing sync for events arriving during a fetch', async () => {
		let release!: () => void;
		let active = 0;
		let maximum = 0;
		const state = setup(async () => {
			maximum = Math.max(maximum, ++active);
			if (state.syncs() === 1)
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			active--;
		});
		state.worker.start();
		await until(() => !!release);
		state.clients[0].emit('exists');
		state.clients[0].emit('flags');
		release();
		await until(() => state.syncs() === 2);
		expect(maximum).toBe(1);
	});

	test('reconnects once after error and close and reconciles missed notifications', async () => {
		const state = setup();
		state.worker.start();
		await until(() => state.syncs() === 1);
		state.clients[0].emit('error');
		await until(() => state.clients.length === 2 && state.syncs() === 2);
		expect(state.clients[0].closed).toBe(true);
		await Bun.sleep(15);
		expect(state.clients).toHaveLength(2);
	});

	test('periodic reconciliation runs even when the provider emits no events', async () => {
		let syncs = 0;
		const worker = new MailWorker(
			{
				accounts: () => [{ id: 'a', userId: 'alice', version: '1' }],
				client: async () => new FakeClient(),
				sync: async () => {
					syncs++;
				},
				failed() {}
			},
			{ scan: 5, reconcile: 25, debounce: 2, retry: 5, maxRetry: 20 }
		);
		workers.push(worker);
		worker.start();
		await until(() => syncs >= 2);
	});

	test('replaces listeners after credential changes and closes removed accounts', async () => {
		const state = setup();
		state.worker.start();
		await until(() => state.syncs() === 1);
		state.accounts[0] = { ...state.accounts[0], version: 'credentials-2' };
		state.worker.scan();
		await until(() => state.clients.length === 2);
		expect(state.clients[0].closed).toBe(true);
		state.accounts.splice(0);
		state.worker.scan();
		expect(state.clients[1].closed).toBe(true);
		const count = state.syncs();
		state.clients[1].emit('exists');
		await Bun.sleep(25);
		expect(state.clients).toHaveLength(2);
		expect(state.syncs()).toBe(count);
	});

	test('shutdown closes a client prepared after shutdown began', async () => {
		let release!: (client: FakeClient) => void;
		const client = new FakeClient();
		const worker = new MailWorker({
			accounts: () => [{ id: 'a', userId: 'alice', version: '1' }],
			client: () =>
				new Promise((resolve) => {
					release = resolve;
				}),
			sync: async () => {},
			failed() {}
		});
		workers.push(worker);
		worker.start();
		worker.stop();
		release(client);
		await until(() => client.closed);
		expect(client.selected).toBe('');
	});
});
