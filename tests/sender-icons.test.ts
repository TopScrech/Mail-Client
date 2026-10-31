import { expect, test } from 'bun:test';
import { websiteIconDomains } from '../src/lib/server/sender-icons';

test('Apple mail subdomains fall back to the main website', () => {
	expect(websiteIconDomains('no_reply@email.apple.com')).toEqual(['email.apple.com', 'apple.com']);
	expect(websiteIconDomains('appstoreconnect-noreply@apple.com')).toEqual(['apple.com']);
	expect(websiteIconDomains('  Sender@MAIL.Apple.COM ')).toEqual(['mail.apple.com', 'apple.com']);
});

test('fallbacks stop at registrable domains including private suffixes', () => {
	expect(websiteIconDomains('sender@news.company.co.uk')).toEqual([
		'news.company.co.uk',
		'company.co.uk'
	]);
	expect(websiteIconDomains('sender@mail.team.github.io')).toEqual([
		'mail.team.github.io',
		'team.github.io'
	]);
	expect(websiteIconDomains('sender@team.github.io')).toEqual(['team.github.io']);
	for (const host of ['co.uk', 'github.io', 'com'])
		expect(websiteIconDomains(`sender@${host}`)).toEqual([]);
});

test('personal providers, invalid addresses and unrecognized domains have no website icon', () => {
	for (const address of [
		'person@gmail.com',
		'person@mail.gmail.com',
		'person@yahoo.co.uk',
		'missing',
		'@apple.com',
		'a@b@apple.com',
		'a@127.0.0.1',
		'a@brand.invalid',
		'a@brand.localhost',
		'a@example.com',
		'a@apple.com/path',
		'a@-apple.com'
	]) {
		expect(websiteIconDomains(address)).toEqual([]);
	}
});
