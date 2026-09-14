import type { Snapshot, Message } from './types';
const entries = [
	[
		'Maya Chen',
		'maya@example.com',
		'A quieter place for our next chapter',
		'Hey,\n\nI took a walk by the water this morning and found that little café we talked about. The one with the big windows and absolutely no music.\n\nIt feels like the perfect place to sit down, sketch a few ideas, and figure out what comes next. No agenda, just good coffee and a little space to think.\n\nAre you free on Thursday around 10?\n\nMaya',
		false,
		true
	],
	[
		'Linear',
		'updates@example.com',
		'Your weekly roundup',
		'A small week of meaningful progress\n\nThe team wrapped up the navigation refresh and polished a few of the details that make everyday work feel better.\n\nSee you next week',
		false,
		false
	],
	[
		'Oliver Grant',
		'oliver@example.com',
		'Re: A few notes on the new direction',
		'Thanks for sending these over\n\nThe simpler version is the one. Let’s give the content a little more room and keep the controls out of the way.\n\nI left a couple of notes in the document\n\nOliver',
		false,
		false
	],
	[
		'The Modern House',
		'journal@example.com',
		'Spaces that give you room to think',
		'This week in the journal\n\nA collection of homes built around light, honest materials, and the things that matter most',
		true,
		false
	],
	[
		'Sofia Andersson',
		'sofia@example.com',
		'Photos from the weekend',
		'Finally had a chance to look through everything\n\nSuch a good few days. Let’s plan another trip before the weather turns\n\nSofia',
		true,
		true
	],
	[
		'GitHub',
		'notifications@example.com',
		'Your pull request has been merged',
		'The changes have been merged into main\n\nThanks for your contribution',
		true,
		false
	],
	[
		'Noah Williams',
		'noah@example.com',
		'Dinner on Friday?',
		'Hey!\n\nWe’re making dinner on Friday. Nothing fancy, just pasta and a few friends\n\nWould love to have you there\n\nNoah',
		true,
		false
	],
	[
		'Are.na',
		'digest@example.com',
		'Connections worth keeping',
		'A few things from your channels this week\n\nCollected slowly, connected thoughtfully',
		true,
		false
	]
] as const;
export function demoSnapshot(): Snapshot {
	return {
		revision: 0,
		accounts: [
			{
				id: 'demo',
				name: 'Personal',
				email: 'alex@example.com',
				imapHost: '',
				smtpHost: '',
				smtpPort: 465,
				lastSync: null,
				error: null
			}
		],
		drafts: [],
		messages: entries.map((x, i): Message => ({
			id: `sample-${i}`,
			accountId: 'demo',
			folder: 'inbox',
			uid: i,
			uidValidity: '1',
			path: 'INBOX',
			from: x[0],
			fromAddress: x[1],
			to: 'alex@example.com',
			subject: x[2],
			text: x[3],
			read: x[4],
			starred: x[5],
			date: new Date(Date.now() - i * 3800_000).toISOString(),
			messageId: '',
			attachments: []
		}))
	};
}
