<script lang="ts">
	import Modal from './Modal.svelte';
	import Icon from './Icon.svelte';
	import type { Profile, MailAccount } from '$lib/types';
	let {
		profile,
		accounts,
		demo = false,
		selectedAccount,
		onaccount,
		busy,
		error,
		onclose,
		onaddpasskey,
		onremovepasskey,
		onrevoke,
		ondisconnect,
		onrename,
		onlogout,
		onconnect
	}: {
		profile: Profile;
		accounts: MailAccount[];
		demo?: boolean;
		selectedAccount: string;
		onaccount: (id: string) => void;
		busy: boolean;
		error: string;
		onclose: () => void;
		onaddpasskey: () => void;
		onremovepasskey: (id: string) => void;
		onrevoke: (id: string) => void;
		ondisconnect: (id: string) => void;
		onrename: (id: string, name: string) => Promise<boolean>;
		onlogout: () => void;
		onconnect: () => void;
	} = $props();
	let disconnectId = $state('');
	let editingId = $state('');
	let accountLabel = $state('');
	const date = (value: string) =>
		new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	function device(label: string) {
		if (label.includes('iPhone')) return 'iPhone';
		if (label.includes('iPad')) return 'iPad';
		if (label.includes('Mac')) return 'Mac';
		if (label.includes('Windows')) return 'Windows';
		if (label.includes('Android')) return 'Android';
		return 'Browser or API client';
	}
</script>

<Modal title="Settings" {onclose}
	><div class="modal-body settings-body">
		<div class="identity">
			<span class="profile-avatar large">{profile.name.charAt(0)}</span>
			<div>
				<strong>{profile.name}</strong><small>{profile.email || 'Apple account'}</small>
			</div>
		</div>
		<section class="settings-section">
			<header>
				<div class="settings-heading">
					<h3>Passkeys</h3>
					<button
						type="button"
						class="passkey-help"
						aria-label="About passkeys"
						title="An alternative way to sign in with your fingerprint, face, or device passcode"
						>?</button
					>
				</div>
				<button class="text-button accent" disabled={busy || demo} onclick={onaddpasskey}
					><Icon name="plus" size={15} /> Add passkey</button
				>
			</header>
			{#each profile.passkeys as key}<div class="settings-row">
					<Icon name="key" size={18} />
					<div><strong>Passkey</strong><small>Added {date(key.createdAt)}</small></div>
					<button class="text-button" disabled={busy} onclick={() => onremovepasskey(key.id)}
						>Remove</button
					>
				</div>{:else}<p class="empty-setting">No passkeys added yet</p>{/each}
		</section>
		<section class="settings-section">
			<header>
				<h3>Mail accounts</h3>
				<button class="text-button accent" onclick={onconnect}
					><Icon name="plus" size={15} /> Connect</button
				>
			</header>
			<button
				class="settings-account-filter"
				class:chosen={!selectedAccount}
				onclick={() => onaccount('')}
				><Icon name="inbox" size={18} /><span>All accounts</span>{#if !selectedAccount}<Icon
						name="check"
						size={16}
					/>{/if}</button
			>{#each accounts as account}<div class="settings-row">
					<span class="account-dot"></span>
					<div>
						<button class="settings-account-name" onclick={() => onaccount(account.id)}
							>{account.name}{#if selectedAccount === account.id}<Icon
									name="check"
									size={14}
								/>{/if}</button
						><small>{account.email}</small><small
							>{account.error ||
								(account.lastSync
									? `Synced ${new Date(account.lastSync).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
									: 'Not synced yet')}</small
						>
					</div>
					<button
						class="text-button"
						disabled={busy}
						onclick={() => {
							editingId = account.id;
							accountLabel = account.name;
						}}>Rename</button
					>
					<button
						class="text-button"
						disabled={busy || demo}
						onclick={() => (disconnectId = account.id)}>Disconnect</button
					>
				</div>
				{#if editingId === account.id}<form
						class="account-label-form"
						onsubmit={async (event) => {
							event.preventDefault();
							if (await onrename(account.id, accountLabel.trim())) editingId = '';
						}}
					>
						<label
							>Account label<input
								bind:value={accountLabel}
								required
								maxlength="100"
								disabled={busy}
							/></label
						>
						<button
							class="text-button"
							type="button"
							disabled={busy}
							onclick={() => (editingId = '')}>Cancel</button
						>
						<button class="secondary" disabled={busy || !accountLabel.trim()}>Save</button>
					</form>{/if}
				{#if disconnectId === account.id}<div class="disconnect-confirm">
						<p>
							Disconnect {account.name} from this workspace on all devices?<br />Cached messages and
							drafts for this account will be removed
						</p>
						<button class="text-button" onclick={() => (disconnectId = '')}>Keep account</button
						><button
							class="text-button danger"
							disabled={busy}
							onclick={() => {
								ondisconnect(account.id);
								disconnectId = '';
							}}>Disconnect</button
						>
					</div>{/if}{:else}<p class="empty-setting">No mail accounts connected</p>{/each}
		</section>
		<section class="settings-section">
			<header>
				<h3>Signed-in devices</h3>
				<Icon name="cloud" size={17} />
			</header>
			{#each profile.sessions as session}<div class="settings-row">
					<Icon name="device" size={19} />
					<div>
						<strong
							>{device(session.label)}
							{#if session.current}<span class="current-label">This device</span>{/if}</strong
						><small>Signed in {date(session.createdAt)}</small>
					</div>
					{#if !session.current}<button
							class="text-button"
							disabled={busy}
							onclick={() => onrevoke(session.id)}>Sign out</button
						>{/if}
				</div>{/each}
		</section>
		{#if error}<p class="error" role="alert">{error}</p>{/if}
	</div>
	<footer class="modal-footer">
		<button class="text-button danger" disabled={busy} onclick={onlogout}
			><Icon name="logout" size={17} /> {demo ? 'Exit preview' : 'Sign out'}</button
		>
	</footer></Modal
>
