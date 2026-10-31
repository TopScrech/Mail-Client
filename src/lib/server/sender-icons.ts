import { parse } from 'tldts';

const personalDomains = new Set([
	'gmail.com',
	'googlemail.com',
	'icloud.com',
	'me.com',
	'mac.com',
	'outlook.com',
	'hotmail.com',
	'live.com',
	'msn.com',
	'yahoo.com',
	'yahoo.co.uk',
	'aol.com',
	'proton.me',
	'protonmail.com',
	'pm.me',
	'hey.com',
	'fastmail.com',
	'mail.com',
	'gmx.com',
	'gmx.de',
	'yandex.com'
]);

// Website artwork is decorative and does not inherit BIMI verification
export function websiteIconDomains(address: string): string[] {
	const parts = address.trim().toLowerCase().split('@');
	if (parts.length !== 2 || !parts[0]) return [];
	const host = parts[1];
	if (
		host.length > 253 ||
		!host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
	)
		return [];
	const result = parse(host, { allowPrivateDomains: true, extractHostname: false });
	if (
		!result.domain ||
		result.isIp ||
		(!result.isIcann && !result.isPrivate) ||
		personalDomains.has(result.domain) ||
		['example.com', 'example.org', 'example.net'].includes(result.domain)
	)
		return [];
	return host === result.domain ? [host] : [host, result.domain];
}
