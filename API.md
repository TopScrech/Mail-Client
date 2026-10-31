# API v1

Base path: `/api/v1`

All private endpoints require the `session` HTTP-only cookie or `Authorization: Bearer <token>` — session lifetime is 30 days, with server-side revocation

Web mutations require the exact configured `Origin` — native clients omit `Origin` and use bearer authentication

JSON errors use `{ "error": "Human-readable message" }` with an appropriate `4xx` or `5xx` status — all API responses are non-cacheable

## Authentication

| Method | Path                             | Behavior                                                                                                                     |
| ------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/config`                        | Reports Apple readiness and approved mail hosts                                                                              |
| GET    | `/auth/apple/start`              | Redirects to Apple’s web authorization flow                                                                                  |
| POST   | `/auth/apple/callback`           | Validates state, exchanges code, verifies identity token, creates or finds the Apple user, sets a cookie, and redirects home |
| POST   | `/auth/passkey/register/options` | Requires a session — creates options for an additional passkey                                                               |
| POST   | `/auth/passkey/register/verify`  | Requires the original session — verifies `{ challengeId, response }`                                                         |
| POST   | `/auth/passkey/login/options`    | Creates discoverable credential options — accepts `{ native: true }` to request a bearer token on successful verification    |
| POST   | `/auth/passkey/login/verify`     | Verifies `{ challengeId, response }` — a verified native flow returns `{ ok, token, expiresIn }`                             |
| GET    | `/me`                            | Profile, registered passkeys, and active sessions with a `current` flag                                                      |
| POST   | `/auth/logout`                   | Revokes the current session                                                                                                  |
| DELETE | `/sessions/:id`                  | Revokes an owned session                                                                                                     |
| DELETE | `/passkeys/:id`                  | Removes an owned passkey — Apple remains the primary account identity                                                        |

Passkey option endpoints return `{ options, challengeId }` — pass `options` to WebAuthn, and return the credential as its JSON representation

Registration never creates a user — Apple signup must happen first

## Mail and device state

| Method | Path                                   | Body or query                                                                                                             |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/sync?since=<revision>`               | Returns `Snapshot`, or HTTP 204 when the revision matches                                                                 |
| GET    | `/events`                             | Authenticated SSE stream — sends `event: revision` with the current revision as numeric `data` on connect and after committed changes |
| POST   | `/accounts`                            | `{ name, email, username?, password, imapHost, smtpHost, smtpPort }` — validates IMAP and SMTP before storing credentials |
| POST   | `/accounts/:id/reconnect` | Same body as `/accounts` with the existing email — verifies credentials and keeps the account ID, cached messages, and drafts |
| DELETE | `/accounts/:id`                        | Disconnects from all devices and removes cached mail and associated drafts — provider mail is untouched                   |
| POST   | `/mail/sync`                           | `{ accountId? }` — synchronizes one or all owned accounts and returns the snapshot plus an `errors` array                 |
| PATCH  | `/messages`                            | `{ id, read?, starred?, folder? }` — destination folder is `inbox`, `archive`, or `trash`                                 |
| GET    | `/attachment?id=<messageId>&index=<n>` | Downloads one attachment as an opaque file                                                                                |
| PUT    | `/drafts`                              | `{ draft }` — `updatedAt` is empty for a new draft, or the timestamp from the last fetched version                        |
| DELETE | `/drafts/:id`                          | Removes an owned draft                                                                                                    |
| POST   | `/send`                                | Multipart: `draft` as JSON, `requestId` as a UUID, and optional repeated `files` fields                                   |

`Snapshot` contains `revision`, `accounts`, `messages`, and `drafts` — the canonical TypeScript wire shapes are in `src/lib/types.ts`

Mailbox sync publishes metadata and queues body downloads separately — a message may initially omit `html` while content is pending, and a later revision supplies its body and attachments — `html: null` marks a loaded plain-text message

Messages may include `bimiLogo`, a base64-encoded 192 × 192 PNG from trusted receiving-provider BIMI results — `null` means checked without usable artwork, and an absent field means not checked yet or an older server

BIMI checks run during metadata sync, including a one-time header backfill for cached messages — the result belongs to the individual message and is never inherited from another message with the same sender

The initial adapter recognizes exact authentication service IDs for Gmail (`mx.google.com`), iCloud (`bimi.icloud.com` and `dmarc.icloud.com`), and Fastmail (`messagingengine.com`), only through their matching IMAP hosts — acceptance requires unique provider results, `dmarc=pass` for the displayed From domain, `bimi=pass`, `policy.authority=pass`, an exact-domain BIMI assertion, and an embedded `BIMI-Indicator` matching `policy.indicator-hash`

This uses the receiving provider's RFC 8601 trust boundary and relies on that provider removing forged results bearing its own authentication service ID — imported or client-appended messages are not independently authenticated by this implementation

Providers and messages without that complete evidence fall back normally — URL-only logos, organizational-domain fallback, standalone certificate verification, and Apple's proprietary Branded Mail are outside this first version — no arbitrary logo URLs are fetched by the server

The native client's avatar order is BIMI → Gravatar → business website icon → initials — Gravatar requests use the SHA-256 hash of the trimmed, lowercase sender address and `d=404`, so a missing Gravatar continues to the website fallback

Body downloads use separate IMAP connections and a persistent queue — retries survive restarts, and completed downloads merge only content fields so newer flags and moves are preserved

Account responses never include passwords — passwords can only be supplied through the connect and reconnect endpoints

Accounts with rejected mail credentials report `reconnectRequired: true` and a reconnect suggestion in `error` — reconnect with the same provider and email to restore access

For Google and Microsoft accounts, repeat the mail OAuth flow with the same email to replace authorization while keeping the existing account and cached mail

Flag updates return `{ ok: true, ...Snapshot }` after provider confirmation

Moves return HTTP 202 with `{ ok: true, pending: true, ...Snapshot }` after saving the intent in the database — pending messages stay hidden across refreshes and mailbox syncs while the provider completes the move

Background reconciliation and sync requests resume persisted moves after a server restart — a failed move restores the cached message and records an account warning

The events stream sends a heartbeat comment every 15 seconds and rechecks session validity before each write — logout and session revocation close matching streams immediately

Fetch `/sync?since=<revision>` after a newer revision notification and after reconnecting — notifications are invalidations, with no replay history, and the initial event always announces the latest revision

Up to 6 streams may share one session — slow consumers are disconnected instead of buffering indefinitely, and EventSource automatically reconnects

The server watches each connected inbox using IMAP IDLE and reconciles all supported folders every 10 minutes, independently of browser activity — authentication failures pause listeners until the account is reconnected

Message identifiers include the account, folder path, UIDVALIDITY, and UID — treat them as opaque strings and URI-encode them where needed

## Draft conflicts

Send the draft’s original `updatedAt` when saving — keep an unsaved local copy until the server acknowledges it

If another device updated or deleted that draft, the server returns `409` instead of overwriting it — fetch the current snapshot and let the user resolve the conflict

## Sending and retries

Generate one UUID per logical send and reuse it for transport retries — never generate a new ID automatically after a timeout

A previously confirmed send returns success without sending again — an in-progress or uncertain submission returns `409`, requiring the user to check Sent

Idempotency records are retained for 7 days — the server cannot guarantee exactly-once SMTP delivery across an ambiguous provider failure

Attachments: up to 10 files, at most 15 MB combined — entire multipart request at most 16 MB

An SMTP acceptance can return a `warning` if some recipients were rejected or saving a Sent copy failed

## Native push notifications

Mail alerts include `aps.category: "MAIL_MESSAGE"` and a top-level `messageId` containing the server message ID
The native app registers a destructive Delete action for that category and sends `PATCH /api/v1/messages` with `{"id":"<messageId>","folder":"trash"}` without marking the message read

Authenticated `PUT /api/v1/push/devices` registers or refreshes an APNs installation

```json
{"token":"hex-encoded APNs device token","environment":"development"}
```

`environment` accepts `development` or `production` and must match the signed app's APNs entitlement
The topic is controlled by the server, never by the client
Returns `{"ok":true}`, or HTTP 503 if APNs credentials are not configured
Authenticated `DELETE /api/v1/push/devices` accepts the same body and removes only a registration owned by that session
Logging out, revoking a session, or deleting a user removes the associated device registrations and queued deliveries
Expired sessions cannot receive pushes

Notifications contain sender, subject, and a `messageId` for navigation, without the message body
The first inbox sync and UIDVALIDITY changes establish a baseline without sending historical alerts
Subsequent new unread inbox messages are queued transactionally, with per-device deduplication, retries, and a one-hour expiry

Messages include `websiteIconDomains` in priority order: the exact sender domain followed by its registrable domain when different — the Public Suffix List includes private suffixes, so fallbacks never cross into shared parents such as `co.uk` or `github.io` — personal mail providers and invalid or unrecognized domains return an empty list

Native avatars try these website icons only after BIMI and Gravatar — website artwork remains decorative and does not establish sender authenticity — candidates are computed for existing messages in each snapshot without a database migration
