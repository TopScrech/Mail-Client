import { describe, expect, test } from 'bun:test';
import { parseMessageBody } from '../src/lib/server/message-body';
import { emailDocument } from '../src/lib/email-document';

const source = (body: string) => Buffer.from(body.replaceAll('\n', '\r\n'));

describe('Email bodies', () => {
	test('preserves HTML styles and tables alongside the plain-text alternative', async () => {
		const result = await parseMessageBody(
			source(`MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="alternative"

--alternative
Content-Type: text/plain; charset=utf-8

Plain fallback
--alternative
Content-Type: text/html; charset=utf-8

<html><head><style>td { color: red }</style></head><body><table><tr><td>Rich message</td></tr></table></body></html>
--alternative--`)
		);
		expect(result.text.trim()).toBe('Plain fallback');
		expect(result.html).toContain('<style>td { color: red }</style>');
		expect(result.html).toContain('<table><tr><td>Rich message</td></tr></table>');
	});

	test('plain text keeps line breaks and records that HTML is absent', async () => {
		const result = await parseMessageBody(
			source('Content-Type: text/plain; charset=utf-8\n\nFirst line\nSecond line')
		);
		expect(result.html).toBeNull();
		expect(result.text).toContain('First line\nSecond line');
	});

	test('HTML-only messages retain a text alternative for previews and replies', async () => {
		const result = await parseMessageBody(
			source('Content-Type: text/html; charset=utf-8\n\n<p>Hello <b>world</b></p>')
		);
		expect(result.html).toBe('<p>Hello <b>world</b></p>');
		expect(result.text).toContain('Hello');
	});

	test('resolves embedded CID images without changing attachment indexes', async () => {
		const result = await parseMessageBody(
			source(`MIME-Version: 1.0
Content-Type: multipart/related; boundary="related"

--related
Content-Type: text/html; charset=utf-8

<p>Logo <img src="cid:logo"></p>
--related
Content-Type: image/png
Content-Disposition: inline; filename="logo.png"
Content-ID: <logo>
Content-Transfer-Encoding: base64

aGVsbG8=
--related--`)
		);
		expect(result.html).toContain('src="data:image/png;base64,aGVsbG8="');
		expect(result.attachments).toEqual([{ index: 0, filename: 'logo.png', size: 5 }]);
	});

	test('puts restrictive policy before sender markup while preserving layout', () => {
		const html = '<style>table { width: 600px }</style><table><tr><td>Hello</td></tr></table>';
		const document = emailDocument(html);
		expect(document).toContain(html);
		expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf(html));
		expect(document).toContain("script-src 'none'");
		expect(document).toContain("form-action 'none'");
		expect(document).toContain('name="referrer" content="no-referrer"');
	});
});
