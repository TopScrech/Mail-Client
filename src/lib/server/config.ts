export const origin = process.env.ORIGIN || 'http://localhost:5173';
export const rpID = process.env.RP_ID || new URL(origin).hostname;
export const secure = origin.startsWith('https://');
export const appleConfigured = () =>
	secure &&
	['APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY'].every(
		(key) => !!process.env[key]
	);
export const allowedHosts = () =>
	(
		process.env.MAIL_ALLOWED_HOSTS ||
		'imap.mail.me.com,smtp.mail.me.com,imap.gmail.com,smtp.gmail.com,imap.fastmail.com,smtp.fastmail.com,outlook.office365.com,smtp.office365.com'
	)
		.split(',')
		.map((x) => x.trim().toLowerCase());
export class ApiError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}
export function assert(condition: unknown, message: string, status = 400): asserts condition {
	if (!condition) throw new ApiError(status, message);
}
export function string(value: unknown, label: string, max = 200) {
	assert(
		typeof value === 'string' && value.trim().length > 0 && value.length <= max,
		`Enter a valid ${label}`
	);
	return value.trim();
}
