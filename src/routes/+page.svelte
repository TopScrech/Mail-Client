<script lang="ts">
	import { onMount } from 'svelte';
	import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
	import { api, RequestError } from '$lib/api';
	import { demoSnapshot } from '$lib/demo';
	import type { Snapshot, Profile, Folder, Message, Draft } from '$lib/types';
	import SignIn from '$lib/components/SignIn.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import MessageList from '$lib/components/MessageList.svelte';
	import Reader from '$lib/components/Reader.svelte';
	import ConnectAccount from '$lib/components/ConnectAccount.svelte';
	import Compose from '$lib/components/Compose.svelte';
	import Settings from '$lib/components/Settings.svelte';
	import Icon from '$lib/components/Icon.svelte';
	let ready = $state(false);
	let profile = $state<Profile | null>(null);
	let mailbox = $state<Snapshot>({ revision: -1, accounts: [], messages: [], drafts: [] });
	let demo = $state(false);
	let appleEnabled = $state(false);
	let folder = $state<Folder>('inbox');
	let selectedAccount = $state('');
	let selected = $state('');
	let query = $state('');
	let busy = $state(false);
	let syncing = $state(false);
	let error = $state('');
	let mailOAuth = $state({ google: false, microsoft: false });
	let toast = $state('');
	let connect = $state(false);
	let settings = $state(false);
	let composer = $state<Draft | null>(null);
	let mobileReading = $state(false);
	let mobileSidebar = $state(false);
	let syncWarning = $state('');
	let toastTimer: ReturnType<typeof setTimeout>;
	let messages = $derived(
		mailbox.messages
			.filter(
				(m) =>
					(!selectedAccount || m.accountId === selectedAccount) &&
					(folder === 'starred' ? m.starred && m.folder !== 'trash' : m.folder === folder) &&
					`${m.from} ${m.fromAddress} ${m.to} ${m.subject} ${m.text}`
						.toLocaleLowerCase()
						.includes(query.toLocaleLowerCase())
			)
			.sort((a, b) => b.date.localeCompare(a.date))
	);
	let drafts = $derived(
		mailbox.drafts.filter(
			(d) =>
				(!selectedAccount || d.accountId === selectedAccount) &&
				`${d.to} ${d.subject} ${d.text}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
		)
	);
	let active = $derived(mailbox.messages.find((m) => m.id === selected));
	function notice(message: string) {
		toast = message;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = ''), 5000);
	}
	async function action(fn: () => Promise<void>) {
		if (busy) return;
		busy = true;
		error = '';
		try {
			await fn();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Something went wrong';
			if (!connect && !settings && !composer && profile) notice(error);
		} finally {
			busy = false;
		}
	}
	async function loadProfile() {
		profile = await api<Profile>('me');
	}
	async function pull() {
		if (demo || !profile) return;
		const userId = profile.id;
		try {
			const next = await api<Snapshot | null>(`sync?since=${mailbox.revision}`);
			if (profile?.id !== userId) return;
			if (next && next.revision > mailbox.revision) mailbox = next;
			syncWarning = '';
		} catch (e) {
			if (e instanceof RequestError && e.status === 401) {
				profile = null;
				mailbox = { revision: -1, accounts: [], messages: [], drafts: [] };
				notice('Your session ended — sign in again');
			} else syncWarning = 'Device sync paused — trying again shortly';
		}
	}
	async function syncMail() {
		if (demo) {
			notice('You’re exploring sample mail');
			return;
		}
		if (syncing || !profile || !mailbox.accounts.length) return;
		const userId = profile.id;
		syncing = true;
		try {
			const next = await api<Snapshot & { errors: string[] }>('mail/sync', 'POST', {});
			if (profile?.id !== userId) return;
			if (next.revision >= mailbox.revision) mailbox = next;
			syncWarning = next.errors.length ? next.errors[0] : '';
		} catch (e) {
			syncWarning = e instanceof Error ? e.message : 'Mail sync failed';
		} finally {
			syncing = false;
		}
	}
	async function login() {
		await action(async () => {
			const { options, challengeId } = await api('auth/passkey/login/options', 'POST', {});
			const response = await startAuthentication({ optionsJSON: options });
			await api('auth/passkey/login/verify', 'POST', { response, challengeId });
			demo = false;
			mailbox.revision = -1;
			await loadProfile();
			await pull();
			void syncMail();
		});
	}
	function preview() {
		demo = true;
		mailbox = demoSnapshot();
		selected = mailbox.messages[0].id;
		error = '';
	}
	function leavePreview() {
		demo = false;
		mailbox = { revision: -1, accounts: [], messages: [], drafts: [] };
		selected = '';
		composer = null;
	}
	function requireReal() {
		if (demo) {
			notice('Sign in with Apple to connect your own mail');
			return false;
		}
		return true;
	}
	function selectFolder(value: Folder) {
		folder = value;
		selected = '';
		query = '';
		mobileReading = false;
		mobileSidebar = false;
	}
	async function selectMessage(message: Message) {
		selected = message.id;
		mobileReading = true;
		if (!message.read) await changeMessage({ read: true }, message);
	}
	async function changeMessage(
		change: { read?: boolean; starred?: boolean; folder?: string },
		message = active
	) {
		if (!message || busy) return;
		if (demo) {
			mailbox.messages = mailbox.messages.map((m) =>
				m.id === message.id ? ({ ...m, ...change } as Message) : m
			);
			if (change.folder) selected = '';
			return;
		}
		await action(async () => {
			await api('messages', 'PATCH', { id: message.id, ...change });
			if (change.folder) {
				selected = '';
				mobileReading = false;
			}
			await pull();
			if (change.folder) void syncMail();
		});
	}
	function compose(reply = false) {
		error = '';
		if (!mailbox.accounts.length) {
			connect = true;
			return;
		}
		const mail = reply ? active : undefined;
		composer = {
			id: crypto.randomUUID(),
			accountId: mail?.accountId || selectedAccount || mailbox.accounts[0].id,
			to: mail?.fromAddress || '',
			subject: mail ? (/^re:/i.test(mail.subject) ? mail.subject : `Re: ${mail.subject}`) : '',
			text: mail
				? `\n\nOn ${new Date(mail.date).toLocaleDateString()}, ${mail.from} wrote:\n${mail.text
						.split('\n')
						.map((x) => `> ${x}`)
						.join('\n')}`
				: '',
			replyTo: mail?.messageId || undefined,
			updatedAt: ''
		};
	}
	async function saveDraft(draft: Draft) {
		if (!draft.to.trim() && !draft.subject.trim() && !draft.text.trim() && !draft.updatedAt) {
			composer = null;
			return;
		}
		if (demo) {
			mailbox.drafts = [
				...mailbox.drafts.filter((d) => d.id !== draft.id),
				{ ...draft, updatedAt: new Date().toISOString() }
			];
			composer = null;
			notice('Sample draft saved for this preview');
			return;
		}
		await action(async () => {
			mailbox = await api('drafts', 'PUT', { draft, revision: mailbox.revision });
			composer = null;
			notice('Draft saved across your devices');
		});
	}
	async function sendDraft(draft: Draft, files: File[], requestId: string) {
		if (!requireReal()) return;
		await action(async () => {
			const data = new FormData();
			data.set('draft', JSON.stringify(draft));
			data.set('requestId', requestId);
			for (const file of files) data.append('files', file);
			const result = await api('send', 'POST', data);
			composer = null;
			notice(result.warning || 'Message sent');
			await pull();
			void syncMail();
		});
	}
	async function discardDraft(draft: Draft) {
		if (demo) {
			mailbox.drafts = mailbox.drafts.filter((x) => x.id !== draft.id);
			composer = null;
			return;
		}
		await action(async () => {
			await api(`drafts/${draft.id}`, 'DELETE');
			composer = null;
			await pull();
		});
	}
	async function connectAccount(data: Record<string, unknown>) {
		await action(async () => {
			await api('accounts', 'POST', data);
			connect = false;
			await pull();
			notice('Account connected — fetching your mail');
			void syncMail();
		});
	}
	async function addPasskey() {
		await action(async () => {
			const { options, challengeId } = await api('auth/passkey/register/options', 'POST', {});
			const response = await startRegistration({ optionsJSON: options });
			await api('auth/passkey/register/verify', 'POST', { response, challengeId });
			await loadProfile();
			notice('Passkey added — use it to sign in next time');
		});
	}
	async function remove(path: string) {
		await action(async () => {
			await api(path, 'DELETE');
			await loadProfile();
			await pull();
		});
	}
	async function logout() {
		await action(async () => {
			await api('auth/logout', 'POST', {});
			profile = null;
			settings = false;
			composer = null;
			selected = '';
			mailbox = { revision: -1, accounts: [], messages: [], drafts: [] };
		});
	}
	function shortcut(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			document.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
			return;
		}
		const editing = (e.target as HTMLElement)?.closest(
			'input, textarea, select, [contenteditable="true"]'
		);
		if (editing || composer || settings || connect || (!profile && !demo)) return;
		if (e.key.toLowerCase() === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey) {
			e.preventDefault();
			compose();
		}
	}
	onMount(() => {
		void (async () => {
			try {
				const config = await api('config');
				appleEnabled = config.appleEnabled;
				mailOAuth = config.mailOAuth;
				try {
					await loadProfile();
					await pull();
					void syncMail();
				} catch (e) {
					if (!(e instanceof RequestError && e.status === 401)) throw e;
				}
				if (!profile && new URL(location.href).searchParams.get('demo') === '1') preview();
				const params = new URL(location.href).searchParams;
				if (params.has('mailError')) {
					connect = true;
					error = params.get('mailError') || 'Mail connection failed';
					history.replaceState(null, '', '/');
				} else if (params.has('mailConnected')) {
					settings = true;
					history.replaceState(null, '', '/');
				}
				const authError = params.get('authError');
				if (authError) {
					error = authError;
					history.replaceState(null, '', '/');
				}
			} catch (e) {
				error = e instanceof Error ? e.message : 'Could not reach the server';
			} finally {
				ready = true;
			}
		})();
		const interval = setInterval(() => {
			if (document.visibilityState === 'visible') void pull();
		}, 5000);
		const mailInterval = setInterval(() => {
			if (document.visibilityState === 'visible') void syncMail();
		}, 120_000);
		const focus = () => void pull();
		window.addEventListener('focus', focus);
		return () => {
			clearInterval(interval);
			clearInterval(mailInterval);
			clearTimeout(toastTimer);
			window.removeEventListener('focus', focus);
		};
	});
</script>

<svelte:head
	><title>Mail Otter</title><meta
		name="description"
		content="A quiet home for your mail, with Apple sign-in, passkeys, and accounts that follow you across devices"
	/></svelte:head
>
<svelte:window onkeydown={shortcut} />
{#if !ready}<div class="loading-screen">
		<span class="app-icon"><Icon name="mail" size={26} /></span><span>Opening your workspace…</span>
	</div>{:else if !profile && !demo}<SignIn
		{appleEnabled}
		{busy}
		{error}
		onpasskey={login}
		onpreview={preview}
	/>{:else}<div class="workspace" class:reading={mobileReading} class:show-sidebar={mobileSidebar}>
		{#if demo}<div class="preview-banner">
				<span><span class="preview-dot"></span>Preview </span><button onclick={leavePreview}
					>Sign in to your workspace <Icon name="chevron" size={14} /></button
				>
			</div>{/if}
		<div class="workspace-panes">
			<Sidebar
				state={mailbox}
				{folder}
				{selectedAccount}
				name={profile?.name || 'Alex Morgan'}
				onfolder={selectFolder}
				onaccount={(id) => {
					selectedAccount = id;
					selected = '';
					mobileSidebar = false;
				}}
				oncompose={() => compose()}
				onconnect={() => {
					if (requireReal()) {
						connect = true;
						error = '';
					}
				}}
				onsettings={() => {
					settings = true;
					error = '';
					if (!demo) void action(loadProfile);
				}}
			/><MessageList
				{messages}
				{drafts}
				{selected}
				{folder}
				{query}
				busy={syncing}
				onquery={(value) => (query = value)}
				onselect={selectMessage}
				ondraft={(draft) => {
					composer = draft;
					error = '';
				}}
				onsync={syncMail}
				onmenu={() => (mobileSidebar = !mobileSidebar)}
			/><Reader
				message={active}
				accountName={mailbox.accounts.find((a) => a.id === active?.accountId)?.name ||
					'All accounts'}
				{busy}
				onback={() => (mobileReading = false)}
				onreply={() => compose(true)}
				onchange={changeMessage}
			/>
		</div>
		{#if syncWarning}<div class="sync-warning" role="status">
				<Icon name="cloud" size={16} />{syncWarning}<button onclick={syncMail} disabled={syncing}
					>Try again</button
				>
			</div>{/if}{#if !demo && !mailbox.accounts.length}<div class="connect-prompt">
				<Icon name="mail" size={20} /><span
					>Your workspace is ready — connect your first mail account</span
				><button
					class="primary"
					onclick={() => {
						connect = true;
						error = '';
					}}>Connect account</button
				>
			</div>{/if}
	</div>{/if}
{#if connect}<ConnectAccount
		{demo}
		{mailOAuth}
		{busy}
		{error}
		onclose={() => {
			if (!busy) connect = false;
		}}
		onconnect={connectAccount}
	/>{/if}
{#if composer}<Compose
		draft={composer}
		accounts={mailbox.accounts}
		{busy}
		{error}
		onclose={() => (composer = null)}
		onsave={saveDraft}
		onsend={sendDraft}
		ondiscard={discardDraft}
	/>{/if}
{#if settings && (profile || demo)}<Settings
		profile={profile || {
			id: 'demo',
			name: 'Alex Morgan',
			email: 'alex@example.com',
			passkeys: [],
			sessions: []
		}}
		{demo}
		{selectedAccount}
		onaccount={(id) => {
			selectedAccount = id;
			selected = '';
			settings = false;
		}}
		accounts={mailbox.accounts}
		{busy}
		{error}
		onclose={() => (settings = false)}
		onaddpasskey={() => {
			if (requireReal()) void addPasskey();
		}}
		onremovepasskey={(id) => remove(`passkeys/${encodeURIComponent(id)}`)}
		onrevoke={(id) => remove(`sessions/${id}`)}
		ondisconnect={(id) => remove(`accounts/${id}`)}
		onrename={async (id, name) => {
			if (busy) return false;
			if (demo) {
				mailbox.accounts = mailbox.accounts.map((account) =>
					account.id === id ? { ...account, name } : account
				);
				return true;
			}
			let saved = false;
			await action(async () => {
				mailbox = await api(`accounts/${encodeURIComponent(id)}`, 'PATCH', { name });
				saved = true;
			});
			return saved;
		}}
		onlogout={() => {
			if (demo) {
				settings = false;
				leavePreview();
			} else void logout();
		}}
		onconnect={() => {
			if (requireReal()) {
				settings = false;
				connect = true;
				error = '';
			}
		}}
	/>{/if}
{#if toast}<div class="toast" role="status"><Icon name="mail" size={17} />{toast}</div>{/if}
