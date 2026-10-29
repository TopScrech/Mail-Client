export interface WatchedAccount {
	id: string;
	userId: string;
	version: string;
}

export interface IdleClient {
	connect(): Promise<unknown>;
	mailboxOpen(path: string): Promise<unknown>;
	close(): void;
	on(event: 'exists' | 'flags' | 'expunge' | 'close' | 'error', listener: () => void): unknown;
}

export interface SyncRequest<Client extends IdleClient = IdleClient> {
	client?: Client;
	reconcile: boolean;
}

interface Dependencies<Client extends IdleClient> {
	accounts(): WatchedAccount[];
	client(account: WatchedAccount): Promise<Client>;
	sync(account: WatchedAccount, request: SyncRequest<Client>): Promise<void>;
	failed(account: WatchedAccount, error: unknown): void;
}

interface Watch<Client extends IdleClient> {
	account: WatchedAccount;
	client?: Client;
	ready: boolean;
	reconcile: boolean;
	retry?: ReturnType<typeof setTimeout>;
	debounce?: ReturnType<typeof setTimeout>;
	syncing: boolean;
	dirty: boolean;
	stopped: boolean;
	attempts: number;
	nextSync: number;
}

export class MailWorker<Client extends IdleClient = IdleClient> {
	private watches = new Map<string, Watch<Client>>();
	private timer?: ReturnType<typeof setInterval>;
	constructor(
		private deps: Dependencies<Client>,
		private timing = {
			scan: 30_000,
			reconcile: 600_000,
			debounce: 300,
			retry: 1000,
			maxRetry: 60_000
		}
	) {}

	start() {
		if (this.timer) return;
		this.scan();
		this.timer = setInterval(() => this.scan(), this.timing.scan);
		this.timer.unref?.();
	}

	// Account additions, credential replacements, and deletions take effect immediately
	scan() {
		const accounts = new Map(this.deps.accounts().map((account) => [account.id, account]));
		for (const [id, watch] of this.watches) {
			if (accounts.get(id)?.version !== watch.account.version) {
				this.stopWatch(watch);
				this.watches.delete(id);
			}
		}
		for (const [id, account] of accounts) {
			let watch = this.watches.get(id);
			if (!watch) {
				watch = {
					account,
					ready: false,
					reconcile: false,
					syncing: false,
					dirty: false,
					stopped: false,
					attempts: 0,
					nextSync: 0
				};
				this.watches.set(id, watch);
				void this.connect(watch);
			}
			if (Date.now() >= watch.nextSync) {
				watch.nextSync = Date.now() + this.timing.reconcile;
				this.requestSync(watch, true);
			}
		}
	}

	stop() {
		clearInterval(this.timer);
		this.timer = undefined;
		for (const watch of this.watches.values()) this.stopWatch(watch);
		this.watches.clear();
	}

	private stopWatch(watch: Watch<Client>) {
		watch.stopped = true;
		clearTimeout(watch.retry);
		clearTimeout(watch.debounce);
		watch.client?.close();
	}

	private async connect(watch: Watch<Client>) {
		let client: Client | undefined;
		let disconnected = false;
		const retry = () => {
			if (disconnected) return;
			disconnected = true;
			watch.ready = false;
			client?.close();
			if (watch.stopped) return;
			const delay = Math.min(
				this.timing.maxRetry,
				this.timing.retry * 2 ** Math.min(watch.attempts++, 10)
			);
			watch.retry = setTimeout(() => void this.connect(watch), delay);
			watch.retry.unref?.();
		};
		try {
			client = await this.deps.client(watch.account);
			if (watch.stopped) return client.close();
			watch.client = client;
			client.on('error', retry);
			client.on('close', retry);
			for (const event of ['exists', 'flags', 'expunge'] as const) {
				client.on(event, () => this.requestSync(watch));
			}
			await client.connect();
			if (watch.stopped || disconnected) return client.close();
			await client.mailboxOpen('INBOX');
			if (watch.stopped || disconnected) return client.close();
			watch.ready = true;
			watch.attempts = 0;
			// Reconcile after every reconnect to cover notifications lost while offline
			this.requestSync(watch, true);
		} catch (error) {
			if (!watch.stopped) this.deps.failed(watch.account, error);
			retry();
		}
	}

	private requestSync(watch: Watch<Client>, reconcile = false) {
		if (watch.stopped) return;
		watch.dirty = true;
		watch.reconcile ||= reconcile;
		if (watch.syncing || watch.debounce) return;
		watch.debounce = setTimeout(() => {
			watch.debounce = undefined;
			void this.sync(watch);
		}, this.timing.debounce);
		watch.debounce.unref?.();
	}

	private async sync(watch: Watch<Client>) {
		if (watch.stopped) return;
		watch.syncing = true;
		watch.dirty = false;
		const request = { client: watch.ready ? watch.client : undefined, reconcile: watch.reconcile };
		watch.reconcile = false;
		try {
			await this.deps.sync(watch.account, request);
		} catch (error) {
			this.deps.failed(watch.account, error);
		} finally {
			watch.syncing = false;
			if (watch.dirty) this.requestSync(watch);
		}
	}
}
