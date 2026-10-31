import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { providerBimiLogo } from '../src/lib/server/bimi';

const svg =
	'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><path fill="red" d="M0 0h100v100H0z"/></svg>';
const auth = (markup = svg) =>
	`mx.google.com; dmarc=pass header.from=brand.example; bimi=pass header.d=brand.example header.selector=default policy.authority=pass policy.indicator-hash=${createHash('sha256').update(markup).digest('hex')}`;
function source(result = auth(), markup = svg, extra = '') {
	return Buffer.from(
		`From: Brand <hello@brand.example>\r\nAuthentication-Results: ${result}\r\nBIMI-Indicator: ${Buffer.from(markup).toString('base64')}\r\n${extra}\r\n`
	);
}
const resolve = (headers = source(), host = 'imap.gmail.com') =>
	providerBimiLogo(headers, host, 'hello@brand.example');

describe('Provider BIMI', () => {
	test('renders a receiver-verified embedded logo as a PNG', async () => {
		const logo = await resolve();
		expect(logo).not.toBeNull();
		expect(Buffer.from(logo!, 'base64').subarray(1, 4).toString()).toBe('PNG');
	});
	test('accepts folded headers, comments and truncated indicator hashes', async () => {
		const result = auth()
			.replace('dmarc=pass', 'dmarc=pass (sender authenticated)')
			.replace(' bimi=', '\r\n\t bimi=')
			.replace(
				/policy.indicator-hash=([a-f0-9]+)/,
				(_, hash) => `policy.indicator-hash="${hash.slice(-8)}"`
			);
		expect(await resolve(source(result))).not.toBeNull();
	});
	test('supports separate iCloud authentication services and Fastmail results', async () => {
		const icloud = auth().replace(
			'mx.google.com; dmarc=pass header.from=brand.example;',
			'bimi.icloud.com;'
		);
		expect(
			await resolve(
				source(
					icloud,
					svg,
					'Authentication-Results: dmarc.icloud.com; dmarc=pass header.from=brand.example\r\n'
				),
				'imap.mail.me.com'
			)
		).not.toBeNull();
		expect(
			await resolve(
				source(auth().replace('mx.google.com', 'messagingengine.com')),
				'imap.fastmail.com'
			)
		).not.toBeNull();
	});
	test('does not trust forwarded results on another provider or an arbitrary IMAP server', async () => {
		expect(await resolve(source(), 'outlook.office365.com')).toBeNull();
		expect(await resolve(source(), 'imap.attacker.example')).toBeNull();
		expect(await resolve(source(), 'imap.fastmail.com')).toBeNull();
	});
	for (const [before, after] of [
		['mx.google.com;', 'mx.google.com.attacker.example;'],
		['dmarc=pass', 'dmarc=fail'],
		['bimi=pass', 'bimi=none'],
		['policy.authority=pass', 'policy.authority=none'],
		['header.from=brand.example', 'header.from=attacker.example'],
		['header.d=brand.example', 'header.d=attacker.example'],
		['bimi=pass', 'bimi=fail (bimi=pass)'],
		['policy.authority=pass', 'policy.authority=pass policy.authority=fail'],
		['bimi=pass', 'bimi=pass; bimi=pass'],
		['policy.indicator-hash=', 'ignored.hash=']
	])
		test(`rejects ${after}`, async () => {
			expect(await resolve(source(auth().replace(before, after)))).toBeNull();
		});
	test('does not interpret results inside quoted property values', async () => {
		const fake = auth().split('; bimi=')[1];
		const result = `mx.google.com; dmarc=pass header.from=brand.example; spf=pass smtp.mailfrom="prefix; bimi=${fake};suffix"`;
		expect(await resolve(source(result))).toBeNull();
	});
	test('rejects duplicate receiver results and ambiguous From or indicator fields', async () => {
		for (const header of [
			`Authentication-Results: ${auth()}`,
			'From: Evil <evil@attacker.example>',
			`BIMI-Indicator: ${Buffer.from(svg).toString('base64')}`
		]) {
			expect(await resolve(source(auth(), svg, `${header}\r\n`))).toBeNull();
		}
		expect(
			await resolve(
				Buffer.from(
					source()
						.toString()
						.replace('Brand <hello@brand.example>', 'hello@brand.example, evil@attacker.example')
				)
			)
		).toBeNull();
	});
	test('rejects tampered, malformed and oversized artwork', async () => {
		expect(await resolve(source(auth(), svg.replace('red', 'blue')))).toBeNull();
		for (const markup of [
			'not svg',
			svg.replace('height="100"', 'height="100000000"'),
			' '.repeat(65_000)
		]) {
			expect(await resolve(source(auth(markup), markup))).toBeNull();
		}
		expect(await resolve(Buffer.alloc(256_001))).toBeNull();
	});
	test('rejects SVG external resources and entity declarations before rendering', async () => {
		for (const payload of [
			'<image href="file:///etc/passwd"/>',
			'<!DOCTYPE svg>',
			'<style>@import "https://example.com"</style>',
			'<rect fill="url(https://example.com)"/>'
		]) {
			const markup = svg.replace('</svg>', `${payload}</svg>`);
			expect(await resolve(source(auth(markup), markup))).toBeNull();
		}
	});
	test('binds the result to the displayed message sender', async () => {
		expect(await providerBimiLogo(source(), 'imap.gmail.com', 'evil@attacker.example')).toBeNull();
		expect(await providerBimiLogo(undefined, 'imap.gmail.com', 'hello@brand.example')).toBeNull();
	});
});
