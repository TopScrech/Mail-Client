<script lang="ts">
	import Icon from './Icon.svelte';
	import type { Folder, Snapshot } from '$lib/types';
	let {
		state,
		folder,
		selectedAccount,
		name,
		onfolder,
		onaccount,
		oncompose,
		onconnect,
		onsettings
	}: {
		state: Snapshot;
		folder: Folder;
		selectedAccount: string;
		name: string;
		onfolder: (folder: Folder) => void;
		onaccount: (id: string) => void;
		oncompose: () => void;
		onconnect: () => void;
		onsettings: () => void;
	} = $props();
	const folders: { id: Folder; label: string; icon: string }[] = [
		{ id: 'inbox', label: 'Inbox', icon: 'inbox' },
		{ id: 'starred', label: 'Starred', icon: 'star' },
		{ id: 'sent', label: 'Sent', icon: 'send' },
		{ id: 'drafts', label: 'Drafts', icon: 'draft' },
		{ id: 'archive', label: 'Archive', icon: 'archive' },
		{ id: 'trash', label: 'Trash', icon: 'trash' }
	];
	let unread = $derived(
		state.messages.filter(
			(m) =>
				!m.read && m.folder === 'inbox' && (!selectedAccount || m.accountId === selectedAccount)
		).length
	);
</script>

<aside class="sidebar">
	<div class="sidebar-brand">
		<span class="app-icon"><Icon name="mail" size={19} /></span><strong>Mail Otter</strong>
	</div>
	<button class="compose-button" onclick={oncompose}
		><Icon name="compose" size={18} /> New message <kbd>N</kbd></button
	>
	<div class="section-label">MAILBOX</div>
	<nav aria-label="Mailboxes">
		{#each folders as item}<button
				class:active={folder === item.id}
				onclick={() => onfolder(item.id)}
				><Icon name={item.icon} size={19} /><span>{item.label}</span
				>{#if item.id === 'inbox' && unread}<span class="count">{unread}</span
					>{:else if item.id === 'drafts' && state.drafts.length}<span class="count"
						>{state.drafts.length}</span
					>{/if}</button
			>{/each}
	</nav>
	<div class="sidebar-bottom">
		<button aria-label="Open settings" title="Settings" class="profile-button" onclick={onsettings}
			><span class="profile-avatar">{name.charAt(0).toUpperCase()}</span><span>{name}</span><Icon
				name="settings"
				size={18}
			/></button
		>
	</div>
</aside>
