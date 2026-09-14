import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { ApiError } from './config';
export const opaque = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function key() {
	const value = Buffer.from(process.env.ENCRYPTION_KEY || '', 'base64');
	if (value.length !== 32)
		throw new ApiError(503, 'The server needs an encryption key before connecting mail accounts');
	return value;
}
export function encrypt(value: string, context: string) {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key(), iv);
	cipher.setAAD(Buffer.from(context));
	const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
	return [iv, cipher.getAuthTag(), data].map((x) => x.toString('base64url')).join('.');
}
export function decrypt(value: string, context: string) {
	const [iv, tag, data] = value.split('.').map((x) => Buffer.from(x, 'base64url'));
	const cipher = createDecipheriv('aes-256-gcm', key(), iv);
	cipher.setAAD(Buffer.from(context));
	cipher.setAuthTag(tag);
	return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
}
