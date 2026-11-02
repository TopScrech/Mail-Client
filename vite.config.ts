import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
export default defineConfig({
	plugins: [
		sveltekit({
			alias: { $lib: 'src/lib' },
			preprocess: vitePreprocess(),
			adapter: adapter(),
			csrf: { trustedOrigins: ['https://appleid.apple.com'] }
		})
	],
	ssr: { external: ['bun:sqlite'] }
});
