import { building } from '$app/environment';
import type { Handle, ServerInit } from '@sveltejs/kit';
import { startPushWorker } from '$lib/server/push';
import { startMailWorker } from '$lib/server/background';

export const init: ServerInit = () => {
	if (building) return;
	const stopMail = startMailWorker();
	const stopPush = startPushWorker();
	const stop = () => {
		stopMail();
		stopPush();
	};
	process.once('sveltekit:shutdown', stop);
	if (import.meta.hot)
		import.meta.hot.dispose(() => {
			stop();
			process.removeListener('sveltekit:shutdown', stop);
		});
};
export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	response.headers.set('x-content-type-options', 'nosniff');
	response.headers.set('referrer-policy', 'no-referrer');
	response.headers.set('x-frame-options', 'DENY');
	response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
	return response;
};
