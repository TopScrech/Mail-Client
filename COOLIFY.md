# Coolify deployment

Create an application from `TopScrech/Mail-Client`, branch `main`, using the **Dockerfile** build pack

- Base directory: `/`
- Dockerfile location: `/Dockerfile`
- Ports Exposes: `3000`
- Public domain: your HTTPS domain, for example `https://mail.example.com`
- Persistent storage: a named volume mounted at `/app/data`, writable by the container’s `bun` user
- Run one application replica — the database is SQLite and mailbox operations are coordinated within one process

## Environment variables

Set these as **runtime** variables — Apple keys and mail encryption keys are not needed during the Docker build

| Variable             | Value                             | Requirement                                                                                |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| `ORIGIN`             | `https://mail.example.com`        | Required — exact public origin, no trailing slash                                          |
| `RP_ID`              | `mail.example.com`                | Set explicitly — defaults to the hostname from `ORIGIN`                                    |
| `ENCRYPTION_KEY`     | Base64-encoded random 32-byte key | Required to connect and decrypt mail accounts — keep stable                                |
| `APPLE_CLIENT_ID`    | Your Apple web Services ID        | Required for Apple signup/sign-in                                                          |
| `APPLE_TEAM_ID`      | Your Apple Developer Team ID      | Required for Apple signup/sign-in                                                          |
| `APPLE_KEY_ID`       | ID of your Sign in with Apple key | Required for Apple signup/sign-in                                                          |
| `APPLE_PRIVATE_KEY`  | Full `.p8` private key            | Required — paste as one line with literal `\n` between lines                               |
| `NODE_ENV`           | `production`                      | Already set by the Dockerfile                                                              |
| `HOST`               | `0.0.0.0`                         | Already set by the Dockerfile                                                              |
| `PORT`               | `3000`                            | Already set by the Dockerfile — must match Ports Exposes                                   |
| `DATABASE_PATH`      | `/app/data/mail-otter.sqlite`     | Already set by the Dockerfile — must stay inside the mounted volume                        |
| `BODY_SIZE_LIMIT`    | `16777216`                        | Already set by the Dockerfile — 16 MB multipart request limit                              |
| `MAIL_ALLOWED_HOSTS` | See list below                    | Optional — defaults to the provider list below                                             |
| `SMTP_SAVES_SENT`    | `false`                           | Optional — set `true` if a non-Gmail provider automatically saves SMTP submissions to Sent |

Default approved mail hosts:

```text
imap.mail.me.com,smtp.mail.me.com,imap.gmail.com,smtp.gmail.com,imap.fastmail.com,smtp.fastmail.com,outlook.office365.com,smtp.office365.com
```

Approval of a hostname does not add provider OAuth support — this version connects with app passwords, so Microsoft 365 accounts that require OAuth cannot connect yet

Generate `ENCRYPTION_KEY` locally:

```sh
bun -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'
```

Keep the encryption key out of Git and retain it across deployments — changing it makes existing mail account credentials unreadable

## Apple configuration

Use a web Services ID associated with your primary App ID, configure the same HTTPS domain, and register this exact Return URL:

```text
https://mail.example.com/api/v1/auth/apple/callback
```

The private key value should look like this, using the contents of your actual `.p8` file:

```text
-----BEGIN PRIVATE KEY-----\nYOUR_KEY_CONTENT\n-----END PRIVATE KEY-----
```

There is no separate `APPLE_REDIRECT_URI` or `DATABASE_URL` variable — the Apple callback URL is derived from `ORIGIN`, and storage is SQLite

Save runtime variables before deploying — after changing them, restart or redeploy the application

## Verify

- `/api/v1/config` should report `appleEnabled: true`
- Create the account with Apple, then add a passkey in Settings
- Connect a mail account with a provider app password
- Sign in on another device to access the same workspace

The host must allow outbound HTTPS, IMAP TLS on port 993, and SMTP on 465 or 587

No Coolify deployment or live Apple/provider sign-in was performed as part of publishing this repository

References: [Coolify Dockerfile configuration](https://coolify.io/docs/applications/builds/dockerfile), [Coolify environment variables](https://coolify.io/docs/applications/configuration/environment-variables)
