# Security policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security problems.

Report it through the contact form at
[jasonparsons.co.uk](https://jasonparsons.co.uk) instead, and include enough detail to
reproduce the issue. I will acknowledge it and work on a fix, though this project is
maintained in spare time so please allow a reasonable window before disclosing publicly.

## What is in scope

This Worker holds a Google service account private key, which makes it a higher value
target than an API key alone. Things worth reporting:

- Anything that leaks `GOOGLE_PRIVATE_KEY`, `GOOGLE_CLIENT_EMAIL` or `MCP_TOKEN`,
  including through error messages, cached responses or logs
- Anything that leaks a Google access token, or lets one be reused outside its intended
  scope
- Any way to bypass the `MCP_TOKEN` check
- Any way to reach a property outside a configured `ALLOWED_SITES` list
- Any way to obtain the read-write Google scope when `ENABLE_WRITES` is not `true`
- Any way to bypass the confirmation required by `delete_sitemap`
- Cache poisoning, or one caller reading another caller's cached responses

## What is not in scope

- Vulnerabilities in Google's APIs, which should go to Google
- Vulnerabilities in Cloudflare Workers, which should go to Cloudflare
- Anything requiring an attacker to already hold your credentials or access token
- Misconfiguration of your own deployment, such as committing a service account key

## For anyone running this

Your service account JSON key is the sensitive item here, more so than any token. It
grants access to every Search Console property you have added the service account to,
and it does not expire.

- Never commit it. The `.gitignore` covers the common filenames, but that is a safety
  net rather than a guarantee.
- If it is ever exposed, create a new key in Google Cloud and delete the old one
  immediately. Deleting the key revokes it, no further action is needed in Search
  Console.
- Grant **Restricted** permission in Search Console unless you specifically need sitemap
  management. Restricted cannot modify anything.
- `MCP_TOKEN` accepts a comma separated list, so you can rotate it without downtime: add
  the new value alongside the old, migrate your clients, then remove the old one.
