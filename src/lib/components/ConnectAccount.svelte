<script lang="ts">
	import Modal from './Modal.svelte';
	import Icon from './Icon.svelte';
	let {
		onclose,
		onconnect,
		busy,
		demo = false,
		mailOAuth,
		error
	}: {
		onclose: () => void;
		onconnect: (data: Record<string, unknown>) => void;
		busy: boolean;
		demo?: boolean;
		mailOAuth: { google: boolean; microsoft: boolean };
		error: string;
	} = $props();
	let provider = $state('icloud');
	let oauth = $derived(provider === 'gmail' || provider === 'microsoft');
	let oauthProvider: 'google' | 'microsoft' = $derived(
		provider === 'gmail' ? 'google' : 'microsoft'
	);
	let email = $state('');
	let name = $state('Personal');
	let username = $state('');
	let password = $state('');
	let imapHost = $state('imap.mail.me.com');
	let smtpHost = $state('smtp.mail.me.com');
	let smtpPort = $state(587);
	function changeProvider(value: string) {
		provider = value;
		if (value === 'icloud') {
			imapHost = 'imap.mail.me.com';
			smtpHost = 'smtp.mail.me.com';
			smtpPort = 587;
		}
		if (value === 'gmail') {
			imapHost = 'imap.gmail.com';
			smtpHost = 'smtp.gmail.com';
			smtpPort = 465;
		}
		if (value === 'fastmail') {
			imapHost = 'imap.fastmail.com';
			smtpHost = 'smtp.fastmail.com';
			smtpPort = 465;
		}
		if (value === 'other') {
			imapHost = '';
			smtpHost = '';
			smtpPort = 465;
		}
	}
</script>

<Modal title="Connect a mail account" subtitle="Connect once and find your mail on every device" {onclose}
	><form
		onsubmit={(e) => {
			e.preventDefault();
			if (oauth) {
				if (!demo && mailOAuth[oauthProvider])
					location.assign(`/api/v1/mail/oauth/${oauthProvider}/start`);
				return;
			}
			onconnect({
				name,
				email,
				username: username || email,
				password,
				imapHost,
				smtpHost,
				smtpPort
			});
		}}
	>
		<div class="modal-body">
			<label
				>Provider<select value={provider} onchange={(e) => changeProvider(e.currentTarget.value)}
					><option value="icloud">iCloud Mail</option><option value="gmail">Gmail</option><option
						value="microsoft">Outlook / Microsoft 365</option
					><option value="fastmail">Fastmail</option><option value="other"
						>Other IMAP account</option
					></select
				></label
			>
			{#if oauth}
				{#if demo}<p class="field-help">Sign in to your workspace to connect a mail account</p>
				{:else if !mailOAuth[oauthProvider]}<p class="field-help">
						This provider has not been configured on the server yet
					</p>{/if}
			{:else}
				<div class="field-pair">
					<label
						>Account name<input
							bind:value={name}
							required
							maxlength="80"
							autocomplete="off"
						/></label
					><label
						>Email address<input
							bind:value={email}
							type="email"
							placeholder="you@example.com"
							required
							autocomplete="email"
						/></label
					>
				</div>
				<label
					>App password<input
						bind:value={password}
						type="password"
						required
						autocomplete="new-password"
						placeholder="Your provider’s app password"
					/></label
				>
				<p class="field-help">
					Use an app password from your mail provider’s security settings<br />Apple sign-in
					protects your workspace and does not grant access to iCloud Mail
				</p>
				<details open={provider === 'other'}>
					<summary>Server settings</summary>
					<div class="advanced-fields">
						<label
							>Username<input
								bind:value={username}
								placeholder={email || 'Same as email address'}
								autocomplete="username"
							/></label
						><label
							>IMAP host <small>TLS · port 993</small><input
								bind:value={imapHost}
								required
								placeholder="imap.example.com"
							/></label
						>
						<div class="field-pair">
							<label
								>SMTP host<input
									bind:value={smtpHost}
									required
									placeholder="smtp.example.com"
								/></label
							><label
								>SMTP port<select bind:value={smtpPort}
									><option value={465}>465 · TLS</option><option value={587}>587 · STARTTLS</option
									></select
								></label
							>
						</div>
					</div>
				</details>
			{/if}
			{#if error}<p class="error" role="alert">{error}</p>{/if}
		</div>
		<footer class="modal-footer">
			<button type="button" class="text-button" disabled={busy} onclick={onclose}>Cancel</button
			><button class="primary" disabled={busy || (oauth && (demo || !mailOAuth[oauthProvider]))}
				>{busy
					? 'Connecting…'
					: oauth
						? `Continue with ${provider === 'gmail' ? 'Google' : 'Microsoft'}`
						: 'Connect account'}<Icon name="chevron" size={16} /></button
			>
		</footer>
	</form></Modal
>
