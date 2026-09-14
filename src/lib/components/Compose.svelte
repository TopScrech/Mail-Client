<script lang="ts">
	import { untrack } from 'svelte';
	import Modal from './Modal.svelte';
	import Icon from './Icon.svelte';
	import type { Draft, MailAccount } from '$lib/types';
	let {
		draft,
		accounts,
		busy,
		error,
		onclose,
		onsave,
		onsend,
		ondiscard
	}: {
		draft: Draft;
		accounts: MailAccount[];
		busy: boolean;
		error: string;
		onclose: () => void;
		onsave: (draft: Draft) => void;
		onsend: (draft: Draft, files: File[], requestId: string) => void;
		ondiscard: (draft: Draft) => void;
	} = $props();
	let local = $state<Draft>(untrack(() => ({ ...draft })));
	let files = $state<File[]>([]);
	let upload: HTMLInputElement;
	const requestId = crypto.randomUUID();
</script>

<Modal title={draft.replyTo ? 'Reply' : 'New message'} onclose={() => onsave(local)} wide
	><form
		onsubmit={(e) => {
			e.preventDefault();
			onsend(local, files, requestId);
		}}
	>
		<div class="compose-fields">
			<label
				><span>From</span><select bind:value={local.accountId} required
					>{#each accounts as account}<option value={account.id}
							>{account.name} &lt;{account.email}&gt;</option
						>{/each}</select
				></label
			><label
				><span>To</span><input
					bind:value={local.to}
					placeholder="Email addresses, separated by commas"
					required
					aria-label="Recipients"
				/></label
			><label
				><span>Subject</span><input
					bind:value={local.subject}
					placeholder="Add a subject"
					maxlength="500"
					aria-label="Subject"
				/></label
			>
		</div>
		<textarea
			class="compose-body"
			bind:value={local.text}
			placeholder="Make a little connection…"
			aria-label="Message body"
			maxlength="200000"></textarea>{#if files.length}<div class="compose-attachments">
				{#each files as file, i}<button
						type="button"
						title="Remove attachment"
						onclick={() => (files = files.filter((_, n) => n !== i))}
						><Icon name="clip" size={14} />{file.name}<Icon name="close" size={13} /></button
					>{/each}<small>Attachments are included when sending and are not saved with drafts</small>
			</div>{/if}{#if error}<p class="error compose-error" role="alert">{error}</p>{/if}
		<footer class="modal-footer compose-footer">
			<button
				type="button"
				class="icon-button"
				disabled={busy}
				title="Discard draft"
				aria-label="Discard draft"
				onclick={() => ondiscard(local)}><Icon name="trash" size={18} /></button
			><button
				type="button"
				class="icon-button"
				disabled={busy}
				title="Attach files"
				aria-label="Attach files"
				onclick={() => upload.click()}><Icon name="clip" size={18} /></button
			><input
				class="hidden"
				bind:this={upload}
				type="file"
				multiple
				onchange={() => {
					files = [...files, ...Array.from(upload.files || [])];
					upload.value = '';
				}}
			/><span class="spacer"></span><button
				type="button"
				class="text-button"
				disabled={busy}
				onclick={() => onsave(local)}>Save draft</button
			><button class="primary" disabled={busy}
				>{busy ? 'Working…' : 'Send'}<Icon name="send" size={17} /></button
			>
		</footer>
	</form></Modal
>
