import type { RequestEvent } from '@sveltejs/kit';
import type { Session } from './auth';
import { one } from './db';
import { assert } from './config';
import { subscribe } from './events';

const connections = new Map<string, Set<() => void>>();

export function closeSessionStreams(sessionId: string) {
	for (const close of connections.get(sessionId) || []) close();
}

export function eventStream(event: RequestEvent, auth: Session) {
	assert((connections.get(auth.id)?.size || 0) < 6, 'Too many live connections', 429);
	let close = () => {};
	const body = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				const encoder = new TextEncoder();
				let closed = false;
				let unsubscribe = () => {};
				let heartbeat: ReturnType<typeof setInterval> | undefined;
				close = () => {
					if (closed) return;
					closed = true;
					unsubscribe();
					clearInterval(heartbeat);
					event.request.signal.removeEventListener('abort', close);
					const group = connections.get(auth.id);
					group?.delete(close);
					if (!group?.size) connections.delete(auth.id);
					try {
						controller.close();
					} catch {
						/* Cancellation already closed the stream */
					}
				};
				const write = (value: string) => {
					if (closed) return;
					// A slow consumer reconnects and fetches the latest revision instead of buffering forever
					if ((controller.desiredSize || 0) <= 0) return close();
					if (
						!one(
							'SELECT id FROM sessions WHERE id=? AND user_id=? AND expires>?',
							auth.id,
							auth.user_id,
							Date.now()
						)
					)
						return close();
					controller.enqueue(encoder.encode(value));
				};
				const notify = () => {
					const user = one<{ revision: number }>(
						'SELECT revision FROM users WHERE id=?',
						auth.user_id
					);
					if (!user) return close();
					write(`event: revision\ndata: ${user.revision}\n\n`);
				};
				let group = connections.get(auth.id);
				if (!group) connections.set(auth.id, (group = new Set()));
				group.add(close);
				unsubscribe = subscribe(auth.user_id, notify);
				event.request.signal.addEventListener('abort', close, { once: true });
				if (event.request.signal.aborted) return close();
				heartbeat = setInterval(() => write(': heartbeat\n\n'), 15_000);
				heartbeat.unref?.();
				// Always send the current revision on connect, including after a lost connection
				notify();
			},
			cancel() {
				close();
			}
		},
		{ highWaterMark: 16 }
	);
	return new Response(body, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-store, no-transform',
			'x-accel-buffering': 'no'
		}
	});
}
