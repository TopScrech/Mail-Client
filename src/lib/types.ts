export type Folder = 'inbox' | 'starred' | 'sent' | 'drafts' | 'archive' | 'trash';
export interface MailAccount {
	id: string;
	email: string;
	name: string;
	imapHost: string;
	smtpHost: string;
	smtpPort: number;
	lastSync: string | null;
	error: string | null;
}
export interface Attachment {
	index: number;
	filename: string;
	size: number;
}
export interface Message {
	id: string;
	accountId: string;
	folder: Folder;
	uid: number;
	uidValidity: string;
	path: string;
	from: string;
	fromAddress: string;
	to: string;
	subject: string;
	text: string;
	html?: string | null;
	date: string;
	read: boolean;
	starred: boolean;
	messageId: string;
	attachments: Attachment[];
}
export interface Draft {
	id: string;
	accountId: string;
	to: string;
	subject: string;
	text: string;
	replyTo?: string;
	updatedAt: string;
}
export interface Snapshot {
	revision: number;
	accounts: MailAccount[];
	messages: Message[];
	drafts: Draft[];
}
export interface Profile {
	id: string;
	name: string;
	email: string;
	passkeys: { id: string; createdAt: string }[];
	sessions: { id: string; label: string; createdAt: string; current: boolean }[];
}
