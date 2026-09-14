<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	let {
		title,
		onclose,
		children,
		wide = false
	}: { title: string; onclose: () => void; children: Snippet; wide?: boolean } = $props();
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
		<h2>{title}</h2>
		<button class="icon-button" aria-label="Close dialog" onclick={onclose}
			><Icon name="close" /></button
		>
	</header>
	{@render children()}
</dialog>
