import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { Resvg } from '@resvg/resvg-js';

// Trust only receiver results delivered through that provider's authenticated IMAP connection
// Matching authserv-ids must be stripped on ingress by the receiving provider (RFC 8601)
const providers: Record<string, { bimi: string; dmarc: string }> = {
	'imap.gmail.com': { bimi: 'mx.google.com', dmarc: 'mx.google.com' },
	'imap.mail.me.com': { bimi: 'bimi.icloud.com', dmarc: 'dmarc.icloud.com' },
	'imap.fastmail.com': { bimi: 'messagingengine.com', dmarc: 'messagingengine.com' }
};

// Remove nested RFC comments without interpreting apparent results inside comments
function uncomment(value: string): string | undefined {
	let depth = 0;
	let quoted = false;
	let escaped = false;
	let result = '';
	for (const character of value) {
		if (escaped) {
			if (!depth) result += character;
			escaped = false;
		} else if (character === '\\') {
			escaped = true;
			if (!depth) result += character;
		} else if (character === '"' && !depth) {
			quoted = !quoted;
			result += character;
		} else if (character === '(' && !quoted) {
			depth++;
		} else if (character === ')' && !quoted) {
			if (!depth) return;
			depth--;
			if (!depth) result += ' ';
		} else if (!depth) result += character;
	}
	return depth || quoted || escaped ? undefined : result;
}

function clauses(value: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (escaped) escaped = false;
		else if (character === '\\') escaped = true;
		else if (character === '"') quoted = !quoted;
		else if (character === ';' && !quoted) {
			parts.push(value.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(value.slice(start));
	return parts;
}

function resultProperties(value: string, method: string): Map<string, string> | undefined {
	const results = clauses(value)
		.slice(1)
		.map((part) => part.trim());
	const matches = results.filter((part) => new RegExp(`^${method}\\s*=`, 'i').test(part));
	if (matches.length !== 1) return;
	const match = matches[0].match(new RegExp(`^${method}\\s*=\\s*pass(?:\\s+|$)(.*)$`, 'i'));
	if (!match) return;
	const properties = new Map<string, string>();
	let rest = match[1].trim();
	while (rest) {
		const property = rest.match(/^([a-z][a-z0-9_.-]*)\s*=\s*(?:"([^"\\]*)"|([^\s";]+))(?:\s+|$)/i);
		if (!property) return;
		const name = property[1].toLowerCase();
		if (properties.has(name)) return;
		properties.set(name, property[2] ?? property[3]);
		rest = rest.slice(property[0].length);
	}
	return properties;
}

/** Returns a bounded PNG, never a sender-controlled URL or executable SVG */
export async function providerBimiLogo(
	headers: Buffer | undefined,
	imapHost: string,
	fromAddress: string
): Promise<string | null> {
	const provider = providers[imapHost.toLowerCase()];
	if (!provider || !headers || headers.length > 256_000) return null;
	try {
		const parsed = await simpleParser(headers, { skipHtmlToText: true, skipTextToHtml: true });
		const lines = parsed.headerLines;
		const values = (key: string) =>
			lines
				.filter((line) => line.key === key)
				.map((line) =>
					line.line
						.slice(line.line.indexOf(':') + 1)
						.replace(/\r?\n[ \t]+/g, ' ')
						.trim()
				);
		if (values('from').length !== 1 || parsed.from?.value.length !== 1) return null;
		const address = parsed.from.value[0].address?.toLowerCase();
		if (!address || address !== fromAddress.trim().toLowerCase()) return null;
		const domain = address.split('@')[1];
		if (!domain) return null;
		const results = values('authentication-results').map(uncomment);
		if (results.some((result) => result === undefined)) return null;
		const trusted = (id: string) => {
			const matches = results.filter((result) => result!.split(';')[0].trim().toLowerCase() === id);
			return matches.length === 1 ? matches[0] : undefined;
		};
		const bimiResult = trusted(provider.bimi);
		const dmarcResult = trusted(provider.dmarc);
		if (!bimiResult || !dmarcResult) return null;
		const bimi = resultProperties(bimiResult, 'bimi');
		const dmarc = resultProperties(dmarcResult, 'dmarc');
		if (!bimi || !dmarc || dmarc.get('header.from')?.toLowerCase() !== domain) return null;
		// Initially accept exact-domain assertions only, without guessing organizational domains
		if (
			bimi.get('header.d')?.toLowerCase() !== domain ||
			bimi.get('policy.authority') !== 'pass' ||
			!bimi.get('header.selector')
		)
			return null;
		const indicators = values('bimi-indicator');
		if (indicators.length !== 1) return null;
		const encoded = indicators[0].replace(/[ \t]/g, '');
		if (
			encoded.length > 90_000 ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
		)
			return null;
		const svg = Buffer.from(encoded, 'base64');
		if (!svg.length || svg.length > 64_000) return null;
		const hash = bimi.get('policy.indicator-hash')?.toLowerCase();
		if (
			!hash ||
			!/^[a-f0-9]{8,64}$/.test(hash) ||
			!createHash('sha256').update(svg).digest('hex').endsWith(hash)
		)
			return null;
		const markup = svg.toString('utf8');
		// No entity expansion, embedded images, file references, or external resources
		if (
			/<!\s*(?:DOCTYPE|ENTITY)|\bhref\s*=|<\s*(?:[\w.-]+:)?(?:image|script|foreignObject|style)\b/i.test(
				markup
			) ||
			/url\s*\(/i.test(markup.replace(/url\(\s*#[\w.-]+\s*\)/gi, ''))
		)
			return null;
		const renderer = new Resvg(svg, {
			fitTo: { mode: 'width', value: 192 },
			font: { loadSystemFonts: false }
		});
		if (
			!Number.isFinite(renderer.width) ||
			renderer.width <= 0 ||
			renderer.width !== renderer.height
		)
			return null;
		const png = renderer.render().asPng();
		return png.length <= 160_000 ? png.toString('base64') : null;
	} catch {
		// Optional artwork must never prevent mail synchronization
		return null;
	}
}
