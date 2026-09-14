<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	onMount(() => {
		if (!/Mac|iPhone|iPad|iPod/.test(navigator.platform + navigator.userAgent)) return;
		const font = new FontFace(
			'Mail Otter Symbols',
			'local("SF Pro"), local("SFPro-Regular"), local("SF Pro Display")'
		);
		let active = true;
		void font
			.load()
			.then((loaded) => {
				if (active) {
					document.fonts.add(loaded);
					document.documentElement.classList.add('sf-symbols-ready');
				}
			})
			.catch(() => {});
		return () => {
			active = false;
			document.documentElement.classList.remove('sf-symbols-ready');
			document.fonts.delete(font);
		};
	});
	let { children } = $props();
</script>

{@render children()}
