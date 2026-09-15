<script lang="ts">
	import Icon from './Icon.svelte';
	import type { Message, Draft, Folder } from '$lib/types';
	let {
		messages,
		drafts,
		selected,
		folder,
		query,
		busy,
		onquery,
		onselect,
		ondraft,
		onsync,
		onmenu
	}: {
		messages: Message[];
		drafts: Draft[];
		selected: string;
		folder: Folder;
		query: string;
		busy: boolean;
		onquery: (value: string) => void;
		onselect: (message: Message) => void;
		ondraft: (draft: Draft) => void;
		onsync: () => void;
		onmenu: () => void;
	} = $props();
	const time = (date: string) =>
		new Intl.DateTimeFormat(
			undefined,
			new Date(date).toDateString() === new Date().toDateString()
				? { hour: 'numeric', minute: '2-digit' }
				: { month: 'short', day: 'numeric' }
		).format(new Date(date));
</script>

<section class="message-list">
	<header class="list-header">
		<div>
			<button class="icon-button mobile-menu" aria-label="Show mailboxes" onclick={onmenu}
				><Icon name="menu" /></button
			>
			<h1>{folder.charAt(0).toUpperCase() + folder.slice(1)}</h1>
			<span class="list-total">{folder === 'drafts' ? drafts.length : messages.length}</span>
		</div>
		<button
			class:spinning={busy}
			class="icon-button"
			disabled={busy}
			aria-label="Sync mail"
			title="Sync mail"
			onclick={onsync}><Icon name="sync" size={18} /></button
		>
	</header>
	<div class="search-wrap">
		<Icon name="search" size={17} /><input
			type="search"
			aria-label="Search mail"
			placeholder="Search mail"
			value={query}
			oninput={(e) => onquery(e.currentTarget.value)}
		/><kbd>⌘ K</kbd>
	</div>
	<div class="list-caption">
		<span
			>{query ? 'SEARCH RESULTS' : folder === 'drafts' ? 'SAVED DRAFTS' : 'LATEST MESSAGES'}</span
		><span>Newest first</span>
	</div>
	<div class="message-scroll">
		{#if folder === 'drafts'}{#each drafts as draft}<button
					class="message-row"
					onclick={() => ondraft(draft)}
					><div class="row-top">
						<strong>{draft.to || 'No recipient'}</strong><time>{time(draft.updatedAt)}</time>
					</div>
					<span class="subject">{draft.subject || 'Untitled draft'}</span>
					<p>{draft.text || 'Keep writing…'}</p>
					<small class="draft-label">Draft</small></button
				>{/each}{:else}{#each messages as message}<button
					class="message-row"
					class:selected={message.id === selected}
					class:unread={!message.read}
					onclick={() => onselect(message)}
					><div class="row-top">
						<span class="unread-marker"></span><strong
							>{folder === 'sent' ? message.to : message.from}</strong
						>{#if message.starred}<span class="starred" aria-label="Starred"
								><Icon name="star" size={13} /></span
							>{/if}<time>{time(message.date)}</time>
					</div>
					<span class="subject">{message.subject}</span>
					<p>{message.text.replaceAll('\n', ' ')}</p>
					{#if message.attachments.length}<div class="row-bottom">
						<Icon name="clip" size={13} />
					</div>{/if}</button
				>{/each}{/if}{#if !(folder === 'drafts' ? drafts.length : messages.length)}<div
				class="list-empty"
			>
				<Icon name={query ? 'search' : folder === 'drafts' ? 'draft' : 'inbox'} size={27} /><strong
					>{query ? 'No matches' : 'Nothing here yet'}</strong
				><span>{query ? 'Try another name or phrase' : 'A little breathing room'}</span>
			</div>{/if}
	</div>
	{#if busy}<footer class="list-footer">Checking for new mail…</footer>{/if}
</section>
