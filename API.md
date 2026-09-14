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
| POST   | `/accounts`                            | `{ name, email, username?, password, imapHost, smtpHost, smtpPort }` — validates IMAP and SMTP before storing credentials |
| DELETE | `/accounts/:id`                        | Disconnects from all devices and removes cached mail and associated drafts — provider mail is untouched                   |
| POST   | `/mail/sync`                           | `{ accountId? }` — synchronizes one or all owned accounts and returns the snapshot plus an `errors` array                 |
| PATCH  | `/messages`                            | `{ id, read?, starred?, folder? }` — destination folder is `inbox`, `archive`, or `trash`                                 |
| GET    | `/attachment?id=<messageId>&index=<n>` | Downloads one attachment as an opaque file                                                                                |
| PUT    | `/drafts`                              | `{ draft }` — `updatedAt` is empty for a new draft, or the timestamp from the last fetched version                        |
| DELETE | `/drafts/:id`                          | Removes an owned draft                                                                                                    |
| POST   | `/send`                                | Multipart: `draft` as JSON, `requestId` as a UUID, and optional repeated `files` fields                                   |

`Snapshot` contains `revision`, `accounts`, `messages`, and `drafts` — the canonical TypeScript wire shapes are in `src/lib/types.ts`

Account responses never include passwords — passwords can only be supplied through the connect endpoint

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
