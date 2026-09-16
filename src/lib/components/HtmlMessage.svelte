<script lang="ts">
	import { emailDocument } from '$lib/email-document';
	let { html }: { html: string } = $props();
</script>

<iframe
	class="html-message"
	title="Email content"
	sandbox="allow-popups allow-popups-to-escape-sandbox"
	referrerpolicy="no-referrer"
	srcdoc={emailDocument(html)}
></iframe>

<style>
	.html-message {
		display: block;
		width: 100%;
		height: 65vh;
		min-height: 320px;
		margin-top: 31px;
		border: 0;
		border-radius: 8px;
		background: white;
	}
</style>
