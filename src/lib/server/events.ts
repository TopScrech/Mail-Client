type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();
const pending = new Set<string>();
const observers = new Set<Listener>();

export function subscribeChanges(listener: Listener) {
	observers.add(listener);
	return () => {
		observers.delete(listener);
	};
}

export function subscribe(userId: string, listener: Listener) {
	let group = listeners.get(userId);
	if (!group) listeners.set(userId, (group = new Set()));
	group.add(listener);
	return () => {
		group.delete(listener);
		if (!group.size) listeners.delete(userId);
	};
}

// Publish after the synchronous SQLite transaction has committed and coalesce writes
export function changed(userId: string) {
	if (pending.has(userId)) return;
	pending.add(userId);
	queueMicrotask(() => {
		pending.delete(userId);
		for (const observer of observers) observer();
		for (const listener of listeners.get(userId) || []) listener();
	});
}
