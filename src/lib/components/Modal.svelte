<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	let {
		title,
		subtitle,
		onclose,
		children,
		wide = false
	}: { title: string; subtitle?: string; onclose: () => void; children: Snippet; wide?: boolean } = $props();
	let dialog: HTMLDialogElement;
	onMount(() => {
		dialog.showModal();
		return () => dialog?.close();
	});
</script>

<dialog
	bind:this={dialog}
	class:wide
	oncancel={(e) => {
		e.preventDefault();
		onclose();
	}}
	aria-label={title}
>
	<header class="modal-header">
		<div>
			<h2>{title}</h2>
			{#if subtitle}<p class="modal-subtitle">{subtitle}</p>{/if}
		</div>
		<button class="icon-button" aria-label="Close dialog" onclick={onclose}
			><Icon name="close" /></button
		>
	</header>
	{@render children()}
</dialog>
