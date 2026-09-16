# Mail Client

A minimal email client built with Svelte 5, SvelteKit, and Bun, with the dark navy palette, blue selection, compact controls, and split panes of SFTP Otter

## Features

- Sign in with Apple
- Passkeys
- One shared workspace across devices, with connected mail accounts, saved drafts, and message state stored on the server
- IMAP inbox, sent, archive, trash, stars, read state, search within cached mail, and account filtering in Settings
- SMTP compose, replies, multiple recipients, and file attachments
- Attachment downloads with a 20 MB message limit, plain-text reading without remote tracking images
- Session listing and revocation, passkey removal, and account disconnection
- Responsive three-pane interface, keyboard compose (`N`), and search (`⌘K` / `Ctrl+K`)
- An explicitly labeled, browser-memory-only preview at `/?demo=1`

## Run locally

Requires Bun 1.4.2 or newer

```sh
git clone https://github.com/TopScrech/Mail-Client.git
cd Mail-Client
```

```sh
bun install --frozen-lockfile
cp .env.example .env
bun -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'
```

Put the generated value in `ENCRYPTION_KEY` in `.env`, then run:

```sh
bun run dev
```

Open [http://localhost:5173](http://localhost:5173) — the origin must match `ORIGIN` exactly for authentication

The sample inbox works before credentials are configured — click **Take a look around**, or open `/?demo=1`

The Bun runtime is required for the backend’s built-in SQLite driver, including when running Vite or the production server

## Sign in with Apple

Apple web sign-in requires an Apple Developer configuration and an HTTPS domain, so it cannot complete on a plain localhost URL

1. Enable Sign in with Apple on a primary App ID in Apple Developer
2. Create a Services ID for the web client, associate it with that primary App ID, and configure the verified web domain
3. Add this exact Return URL: `https://your-domain/api/v1/auth/apple/callback`
4. Create a Sign in with Apple key and download its `.p8` file
5. Set these environment values:

| Variable            | Value                                                                   |
| ------------------- | ----------------------------------------------------------------------- |
| `ORIGIN`            | `https://your-domain` without a trailing slash                          |
| `RP_ID`             | `your-domain` without a scheme or port                                  |
| `APPLE_CLIENT_ID`   | Web Services ID                                                         |
| `APPLE_TEAM_ID`     | Apple Developer Team ID                                                 |
| `APPLE_KEY_ID`      | Signing key identifier                                                  |
| `APPLE_PRIVATE_KEY` | Full `.p8` content, using literal `\n` separators if stored on one line |
| `ENCRYPTION_KEY`    | A stable, base64-encoded random 32-byte key                             |

Use a deployed HTTPS host or an HTTPS development tunnel registered with Apple, with `ORIGIN` and `RP_ID` set to that domain

Apple authorization uses a one-time state cookie, server-stored nonce, authorization-code exchange, and verification of the identity token’s signature, issuer, audience, and nonce

Accounts are keyed by Apple’s stable subject identifier, never merged by email address — Hide My Email is supported

After the first Apple sign-in, open **Settings → Passkeys → Add passkey**

Provider references: [Apple token validation](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens), [SimpleWebAuthn server verification](https://simplewebauthn.dev/docs/packages/server)

## Connect mail

**Settings → Mail accounts → Connect** supports iCloud Mail, Gmail, Fastmail, and operator-approved IMAP/SMTP hosts

Use a provider app password — signing into the workspace with Apple does not authorize reading iCloud Mail

IMAP requires TLS on port 993 — SMTP uses TLS on 465 or mandatory STARTTLS on 587, with certificate verification enabled

`MAIL_ALLOWED_HOSTS` is an exact hostname allowlist controlled by the server operator — add your own mail servers there before connecting them, and allow only trusted public mail infrastructure

The same username and app password are used for IMAP and SMTP — provider OAuth, Microsoft 365 OAuth-only accounts, and providers that disable app passwords need a future OAuth connector

Sent messages are appended to the IMAP Sent folder after SMTP acceptance, except for Gmail, which saves them automatically — set `SMTP_SAVES_SENT=true` if your other provider does this too

The Sent, Archive, and Trash folders must advertise their IMAP special-use flags — custom folder mapping is not yet exposed

## Sync behavior

- The Bun server is the source of truth, with per-user revision numbers and a `204` response when nothing changed
- Visible web clients check shared workspace state every 5 seconds and on focus
- Connected mail accounts refresh every 2 minutes while the client is visible, on sign-in, or when manually refreshed
- Sync caches the newest 50 messages in each supported folder per account, up to 10 accounts
- Search covers this cached window, not the provider’s full mailbox
- Draft saves use optimistic concurrency based on the original `updatedAt` value — stale edits return `409` and remain open in the composer
- Attachments are sent immediately or downloaded on demand — unsent attachments stay on the composing device and are not part of saved drafts
- Operations for a workspace are serialized inside one Bun process — deploy one application replica with a persistent database volume
- There is no background worker, push delivery, offline compose persistence, or full mailbox pagination in this version

## Storage and deployment

```sh
bun run check
bun test
bun run build
bun run start
```

For production, set `ORIGIN` to the HTTPS public domain, `RP_ID` to its hostname, and `BODY_SIZE_LIMIT=16777216`

Deploy the Bun server behind an HTTPS reverse proxy with request timeouts long enough for initial IMAP sync — Apple authentication, SMTP, and IMAP require outbound network access

A Dockerfile is included:

```sh
docker build -t mail-client .
docker run --env-file .env -p 3000:3000 -v mail-client-data:/app/data mail-client
```

Use a production-specific env file without the local relative `DATABASE_PATH`, or set it to `/app/data/mail-otter.sqlite` when using Docker

The SQLite database stores identity, hashed session tokens, public passkey credentials, cached mail, and drafts — mail passwords use AES-256-GCM with account- and user-specific authenticated context

Cached messages and drafts are not end-to-end encrypted — use encrypted disks and restricted backups for the database, and back up the encryption key separately

Keep the encryption key stable across restarts and devices — losing it makes connected mail credentials unreadable

This Bun/TCP/SQLite backend is intended for a persistent server or container, rather than Cloudflare Workers/Sites hosting

## Future SwiftUI clients

The versioned HTTP interface under `/api/v1` is independent of Svelte — see [API.md](API.md)

Native passkey sign-in can obtain a bearer session through the same challenge and verification API — configure Associated Domains and host an `apple-app-site-association` file with your real app identifiers when creating the native apps

Native Apple signup will need an AuthenticationServices token-exchange endpoint and configured native audiences, or a dedicated secure web-auth handoff — the current Apple callback is the web flow and does not place session credentials in URLs

Group the future native App IDs with the same primary Sign in with Apple App ID so they share the intended Apple identity relationship

## Validation

Type checks, the production build, and backend tests cover authentication boundaries, challenge replay/expiry, credential encryption, tenant isolation, draft conflicts, rate limits, payload limits, and session revocation

Live Apple sign-in, real-device passkey enrollment, provider delivery, and cross-device end-to-end behavior require configured credentials and devices — they are not claimed as live-tested

## Icons

The web client prefers actual SF Symbols glyphs from a locally installed SF Pro font on Apple devices, with vector fallbacks when that font is unavailable — no Apple font files are redistributed

Semantic icon aliases map to SF Symbols names in `src/lib/symbols.ts`, ready to use with `Image(systemName:)` in the future SwiftUI apps

The SF Pro glyph coverage was checked against all 24 mapped icons on the development Mac — other font versions may differ

## Coolify

See [COOLIFY.md](COOLIFY.md) for runtime environment variables, Apple return URL, and persistent volume configuration

## Google and Microsoft mail accounts

Workspace creation still uses Apple, with passkeys for subsequent sign-in
In Settings → Mail accounts → Connect, Gmail and Outlook / Microsoft 365 redirect to the provider's authorization page
Tokens are encrypted with the existing `ENCRYPTION_KEY` and renewed server-side for every device
Connect the same email again to renew authorization without removing its label or drafts

Add these runtime environment variables in Coolify and redeploy:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`

Keep `ORIGIN=https://mail.topscrech.dev` and the existing encryption key
A provider is unavailable until both its client ID and client secret are set

For Google, create a Web application OAuth client in Google Cloud and configure the consent screen with `openid`, `email`, and `https://mail.google.com/`
Register `https://mail.topscrech.dev/api/v1/mail/oauth/google/callback` as an authorized redirect URI
Add your Google account as a test user while the consent screen is in Testing
Google's full-mail scope for IMAP/SMTP is restricted; public distribution requires Google's verification process and may require a security assessment
Testing-mode refresh tokens for these scopes generally expire after seven days
See [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server) and [Gmail OAuth scopes](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol)

For Microsoft, register a Web app in Microsoft Entra supporting accounts in any organizational directory and personal Microsoft accounts
Register `https://mail.topscrech.dev/api/v1/mail/oauth/microsoft/callback` and create a client secret (use its value, not its ID)
Configure delegated Exchange Online permissions `IMAP.AccessAsUser.All` and `SMTP.Send`, plus OpenID `openid`, `email`, `profile`, and `offline_access`
The app uses the common tenant endpoint for Outlook.com and Microsoft 365
IMAP and authenticated SMTP must be enabled for the mailbox; organization policies may require administrator consent or block these protocols
See [Microsoft mail OAuth](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)

For local testing, register the corresponding `http://localhost:5173/api/v1/mail/oauth/<provider>/callback` URI on a development OAuth client
Never expose client secrets or tokens to the browser or commit them to Git
