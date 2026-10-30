import type { WatchedAccount } from './mail-worker';

interface Dependencies {
	accounts(): WatchedAccount[];
	hasJobs(account: WatchedAccount): boolean;
	download(account: WatchedAccount, signal: AbortSignal): Promise<void>;
	failed(account: WatchedAccount, error: unknown): void;
}

// Body I/O has its own connections and never occupies the inbox worker or mutation lock
export class BodyWorker {
	private active = new Map<string, { version: string; abort: AbortController }>();
	private retryAt = new Map<string, number>();
	private timer?: ReturnType<typeof setInterval>;
	private stopped = true;
	constructor(
		private deps: Dependencies,
		private concurrency = 2,
		private interval = 1000
	) {}

	start() {
		if (!this.stopped) return;
		this.stopped = false;
		this.timer = setInterval(() => this.scan(), this.interval);
		this.timer.unref?.();
		this.scan();
	}

	scan() {
		if (this.stopped) return;
		const accounts = new Map(this.deps.accounts().map((account) => [account.id, account]));
		for (const [id, active] of this.active) {
			if (accounts.get(id)?.version !== active.version) active.abort.abort();
		}
		for (const id of this.retryAt.keys()) if (!accounts.has(id)) this.retryAt.delete(id);
		for (const account of accounts.values()) {
			if (this.active.size >= this.concurrency) break;
			if (
				this.active.has(account.id) ||
				(this.retryAt.get(account.id) || 0) > Date.now() ||
				!this.deps.hasJobs(account)
			)
				continue;
			const abort = new AbortController();
			this.active.set(account.id, { version: account.version, abort });
			void this.run(account, abort);
		}
	}

	stop() {
		this.stopped = true;
		clearInterval(this.timer);
		for (const active of this.active.values()) active.abort.abort();
		this.retryAt.clear();
	}

	private async run(account: WatchedAccount, abort: AbortController) {
		try {
			await this.deps.download(account, abort.signal);
			this.retryAt.delete(account.id);
		} catch (error) {
			if (!abort.signal.aborted) {
				this.retryAt.set(account.id, Date.now() + this.interval);
				this.deps.failed(account, error);
			}
		} finally {
			this.active.delete(account.id);
			queueMicrotask(() => this.scan());
		}
	}
}
