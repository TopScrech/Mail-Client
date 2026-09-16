import { simpleParser } from 'mailparser';
import type { Message } from '../types';

export async function parseMessageBody(source: Buffer) {
	const parsed = await simpleParser(source, {
		skipHtmlToText: false,
		skipTextToHtml: true
	});
	return {
		text: (parsed.text || '').slice(0, 200_000),
		html: parsed.html || null,
		attachments: parsed.attachments.map((attachment, index) => ({
			index,
			filename: attachment.filename || 'Attachment',
			size: attachment.size
		}))
	} satisfies Pick<Message, 'text' | 'html' | 'attachments'>;
}
