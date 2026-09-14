<script lang="ts">
	import Icon from './Icon.svelte';
	let {
		appleEnabled,
		busy,
		error,
		onpasskey,
		onpreview
	}: {
		appleEnabled: boolean;
		busy: boolean;
		error: string;
		onpasskey: () => void;
		onpreview: () => void;
	} = $props();
</script>

<div class="signin">
	<a class="wordmark" href="/"
		><span class="app-icon"><Icon name="mail" size={21} /></span>Mail Otter</a
	>
	<main class="signin-content">
		<div class="signin-symbol"><Icon name="mail" size={38} /></div>
		<h1>A little space for your mail</h1>
		<p>All your accounts, quietly together<br />Pick up where you left off on any device</p>
		<div class="signin-actions">
			{#if appleEnabled}<a class="apple-button" href="/api/v1/auth/apple/start"
					><span class="apple-mark" aria-hidden="true"></span> Sign in with Apple</a
				>{:else}<button class="apple-button" disabled
					><span class="apple-mark" aria-hidden="true"></span> Sign in with Apple</button
				>{/if}<button class="secondary" disabled={busy} onclick={onpasskey}
				><Icon name="key" size={18} />
				{busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}</button
			>
		</div>
		<small
			>New here? Create your account with Apple<br />You can add a passkey in Settings afterward</small
		>{#if !appleEnabled}<div class="setup-note">
				<Icon name="settings" size={17} /><span
					>Apple sign-in needs server configuration before you can create an account</span
				>
			</div>{/if}{#if error}<p class="error" role="alert">{error}</p>{/if}<button
			class="preview-link"
			onclick={onpreview}>Take a look around <Icon name="chevron" size={14} /></button
		>
	</main>
	<footer><Icon name="shield" size={15} /> Your mail, your space</footer>
</div>
