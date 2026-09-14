export class RequestError extends Error {
	constructor(
		message: string,
		public status: number
	) {
		super(message);
	}
}
export async function api<T = any>(path: string, method = 'GET', data?: unknown): Promise<T> {
	const response = await fetch(`/api/v1/${path}`, {
		method,
		credentials: 'same-origin',
		headers: data instanceof FormData ? {} : { 'content-type': 'application/json' },
		body: data === undefined ? undefined : data instanceof FormData ? data : JSON.stringify(data)
	});
	if (response.status === 204) return null as T;
	const result = await response.json();
	if (!response.ok) throw new RequestError(result.error || 'Something went wrong', response.status);
	return result;
}
