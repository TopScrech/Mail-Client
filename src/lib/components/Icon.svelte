<script lang="ts">
	import { symbols } from '$lib/symbols';
	let { name, size = 20 }: { name: string; size?: number } = $props();
	const paths: Record<string, string> = {
		mail: 'M4 5h16v14H4z M4 6l8 7 8-7',
		inbox: 'M4 4h16l2 12v4H2v-4L4 4z M2 15h6l2 3h4l2-3h6',
		star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3z',
		send: 'm21 3-7 18-4-7-7-4 18-7z M10 14 21 3',
		draft: 'M14 3H5v18h14V8l-5-5z M14 3v5h5 M8 13h8 M8 17h5',
		archive: 'M3 3h18v5H3z M5 8v13h14V8 M9 12h6',
		trash: 'M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
		search: 'M21 21l-5-5 M18 10a8 8 0 1 0-16 0 8 8 0 0 0 16 0',
		plus: 'M12 5v14 M5 12h14',
		compose: 'M13 5H4v16h16v-9 M10 14l1-5 9-8 3 3-9 9-4 1z',
		sync: 'M20 7a9 9 0 0 0-15-2L2 8 M2 3v5h5 M4 17a9 9 0 0 0 15 2l3-3 M22 21v-5h-5',
		settings:
			'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3z',
		chevron: 'm9 5 7 7-7 7',
		back: 'm15 5-7 7 7 7',
		close: 'm6 6 12 12 M6 18 18 6',
		check: 'm5 12 4 4L19 6',
		key: 'M14 3a7 7 0 0 0-6 10l-6 6v3h5v-3h3v-3l1-1a7 7 0 1 0 3-12z M16 7h.01',
		reply: 'm9 5-7 7 7 7 M2 12h11a8 8 0 0 1 8 8',
		clip: 'm8 12 7-7a4 4 0 0 1 6 6L10 22a6 6 0 0 1-8-8L13 3 M5 17 16 6',
		logout: 'M9 3H3v18h6 M9 12h13 m-5-5 5 5-5 5',
		shield: 'm12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4z m-5 10 3 3 7-7',
		cloud: 'M7 19a5 5 0 1 1 0-10 7 7 0 0 1 14 3 4 4 0 0 1-1 7H7',
		menu: 'M4 6h16 M4 12h16 M4 18h16',
		device: 'M3 4h18v13H3z M8 21h8 M12 17v4'
	};
</script>

<span
	class="sf-symbol-icon"
	style:width={`${size}px`}
	style:height={`${size}px`}
	style:font-size={`${size}px`}
	data-symbol={symbols[name]?.name || 'envelope'}
	aria-hidden="true">{symbols[name]?.glyph || symbols.mail.glyph}</span
>
<svg
	class="vector-icon"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.6"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"><path d={paths[name] || paths.mail} /></svg
>
