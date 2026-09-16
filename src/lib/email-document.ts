// The iframe sandbox must remain enabled without allow-scripts or allow-same-origin
export function emailDocument(html: string) {
	return `<!doctype html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>:root { color-scheme: light; } body { margin: 16px; font-family: sans-serif; overflow-wrap: anywhere; color: #202124; background: #fff; } img { max-width: 100%; height: auto; }</style>
</head><body>${html}</body></html>`;
}
