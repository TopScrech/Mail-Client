<script lang="ts">
	import Icon from './Icon.svelte';
	import type { Message } from '$lib/types';
	let {
		message,
		accountName,
		busy,
		onback,
		onreply,
		onchange
	}: {
		message: Message | undefined;
		accountName: string;
		busy: boolean;
		onback: () => void;
		onreply: () => void;
		onchange: (change: { read?: boolean; starred?: boolean; folder?: string }) => void;
	} = $props();
</script>

<section class="reader">
	<header class="reader-toolbar">
		<button class="icon-button reader-back" aria-label="Back to messages" onclick={onback}
			><Icon name="back" /></button
		>
		<div class="reader-actions">
			<button
				class="icon-button"
				aria-label="Archive message"
				title="Archive"
				disabled={!message || busy}
				onclick={() => onchange({ folder: 'archive' })}><Icon name="archive" size={19} /></button
			><button
				class="icon-button"
				aria-label="Move to trash"
				title="Move to trash"
				disabled={!message || busy}
				onclick={() => onchange({ folder: 'trash' })}><Icon name="trash" size={19} /></button
			><span class="toolbar-divider"></span><button
				class="icon-button"
				aria-label={message?.read ? 'Mark unread' : 'Mark read'}
				title={message?.read ? 'Mark unread' : 'Mark read'}
				disabled={!message || busy}
				onclick={() => onchange({ read: !message?.read })}><Icon name="mail" size={19} /></button
			>
		</div>
		<div class="reader-actions">
			<button
				class="icon-button"
				class:starred={message?.starred}
				aria-label={message?.starred ? 'Remove star' : 'Star message'}
				title="Star message"
				disabled={!message || busy}
				onclick={() => onchange({ starred: !message?.starred })}
				><Icon name="star" size={19} /></button
			><button
				class="icon-button"
				aria-label="Reply"
				title="Reply"
				disabled={!message}
				onclick={onreply}><Icon name="reply" size={20} /></button
			>
		</div>
	</header>
	{#if message}<article class="message-content">
			<div class="message-account"><span class="account-dot"></span>{accountName}</div>
			<h2>{message.subject}</h2>
			<div class="sender-line">
				<div class="sender-avatar">{message.from.charAt(0).toUpperCase()}</div>
				<div class="sender-details">
					<strong>{message.from}</strong><span>{message.fromAddress}</span><small
						>To {message.to}</small
					>
				</div>
				<time
					>{new Intl.DateTimeFormat(undefined, {
						month: 'short',
						day: 'numeric',
						hour: 'numeric',
						minute: '2-digit'
					}).format(new Date(message.date))}</time
				>
			</div>
			<div class="mail-body">{message.text || 'This message has no text content'}</div>
			{#if message.attachments.length}<div class="attachments">
					{#each message.attachments as file}<a
							href={`/api/v1/attachment?id=${encodeURIComponent(message.id)}&index=${file.index}`}
							download
							><Icon name="clip" size={18} /><span
								>{file.filename}<small
									>{new Intl.NumberFormat(undefined, {
										style: 'unit',
										unit: 'kilobyte',
										maximumFractionDigits: 0
									}).format(file.size / 1024)}</small
								></span
							></a
						>{/each}
				</div>{/if}<button class="reply-button" onclick={onreply}
				><Icon name="reply" size={18} /> Reply to {message.from.split(' ')[0]}</button
			>
		</article>{:else}<div class="reader-empty">
			<div class="empty-symbol"><Icon name="mail" size={33} /></div>
			<h2>A little room to focus</h2>
			<p>Select a message to settle in</p>
		</div>{/if}
</section>
