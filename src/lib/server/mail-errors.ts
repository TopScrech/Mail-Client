import { ApiError } from './config';

export class MailAuthError extends ApiError {
	constructor() {
		super(422, 'Mail authorization failed — connect the account again');
	}
}

export function isMailAuthError(error: unknown): boolean {
	if (error instanceof MailAuthError) return true;
	if (!error || typeof error !== 'object') return false;
	const failure = error as { authenticationFailed?: boolean; code?: string };
	return failure.authenticationFailed === true || failure.code === 'EAUTH';
}
