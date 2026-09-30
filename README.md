# mcp-googlesearchconsole

An MCP server for [Google Search Console](https://search.google.com/search-console),
running on Cloudflare Workers. Ask your AI assistant about your search performance
instead of exporting from the UI.

**Connect Google Search Console to Claude, Claude Code, Cursor or any MCP client.**
No local install, no Node.js, no Python. It runs as a remote Worker in your own
Cloudflare account, so it works from mobile as well as desktop and keeps working when
your laptop is closed.

> "Which queries did we lose rankings on last month?"
> "Is the pricing page indexed?"
> "What are people searching for before they land on the blog?"

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jason-mspkickstart/mcp-googlesearchconsole)

One click clones this repo to your GitHub and deploys it to your own Cloudflare
account. Your service account credentials stay in your Worker, never anyone else's.
Free on Cloudflare's free plan, with no seat limits and nothing hosted by us.

---

## Contents

- [Before you start](#before-you-start)
- [Google setup](#google-setup) — the fiddly bit, done once
- [Cloudflare setup](#cloudflare-setup)
- [Connecting your AI assistant](#connecting-your-ai-assistant)
- [Tools](#tools)
- [Troubleshooting](#troubleshooting)

---

## Before you start

You need a Google account with access to at least one Search Console property, and a
Cloudflare account. The free plan is fine for both.

You do **not** need Node.js or any local tooling. Everything below can be done in a
browser.

**Search Console has no simple API key.** Access goes through a Google Cloud service
account, which is why setup is longer than for other providers. It is a one-time cost,
and once done the credentials never expire.

---

## Google setup

### 1. Create a Google Cloud project

At [console.cloud.google.com](https://console.cloud.google.com), click the project
dropdown at the top left, then **New Project**. Name it something like
`mcp-search-console`. No billing is required, the Search Console API is free.

### 2. Enable the Search Console API

With that project selected, go to **APIs & Services** → **Library**. Search for
**Google Search Console API** and click **Enable**.

Do not confuse this with the **Indexing API**, which is a different product that only
works for job postings and livestream pages.

### 3. Create a service account

**APIs & Services** → **Credentials** → **Create credentials** → **Service account**.

Name it something like `search-console-reader`. Skip the optional steps about project
roles and user access, they govern Google Cloud permissions and are not what controls
Search Console access.

Copy the generated email address, which looks like
`search-console-reader@your-project.iam.gserviceaccount.com`. You need it twice below.

### 4. Download the JSON key

Open the service account, go to the **Keys** tab, then **Add key** → **Create new key**
→ **JSON**. A file downloads.

**This file is a credential. Treat it like a password.** It is shown once. Do not commit
it, do not paste it into a chat. Two fields matter: `client_email` and `private_key`.

### 5. Grant access in Search Console

This is the step people miss. Enabling the API grants access to nothing by itself.

For **each property** you want reachable, go to
[search.google.com/search-console](https://search.google.com/search-console), select the
property, then **Settings** → **Users and permissions** → **Add user**. Paste the
service account email and choose a permission level:

| Level | Gives |
| --- | --- |
| **Restricted** | Read access to performance data. Enough for all the read tools. |
| **Full** | Also allows submitting and deleting sitemaps. |

Start with Restricted, and only use Full on properties where you actually want sitemap
management. You must be an Owner of a property to add users, so for client properties
where you are a delegated user, the client has to do this.

---

## Cloudflare setup

### 1. Deploy

Use the **Deploy to Cloudflare** button at the top of this README. It forks the repo to
your GitHub account and sets the Worker up for you, then redeploys on every push.

<details>
<summary>Or set it up manually</summary>

Fork this repository, then in the Cloudflare dashboard: **Compute (Workers)** →
**Create** → **Import a repository**. Connect GitHub, pick your fork, then:

| Setting | Value |
| --- | --- |
| Branch | `main` |
| Build command | *leave empty* |
| Deploy command | `npx wrangler deploy` |

</details>

Check `https://mcp-googlesearchconsole.<your-subdomain>.workers.dev/health` returns `ok`.

### 2. Generate an access token

PowerShell:

```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```

macOS or Linux:

```bash
openssl rand -hex 32
```

### 3. Add secrets

Open the Worker → **Settings** → **Variables and Secrets**. Add each as type **Secret**:

| Name | Value |
| --- | --- |
| `GOOGLE_CLIENT_EMAIL` | `client_email` from the JSON key |
| `GOOGLE_PRIVATE_KEY` | `private_key` from the JSON key, the whole thing including the BEGIN and END lines |
| `MCP_TOKEN` | The token from step 2 |
| `ALLOWED_SITES` | *Optional.* Comma separated property identifiers |

Paste `private_key` exactly as it appears in the JSON. The escaped `\n` sequences and
surrounding quotes are both handled, so you do not need to reformat anything.

`MCP_TOKEN` is mandatory. There is no bring-your-own-key mode on this server, because a
service account key is a file rather than something a caller can reasonably pass with
each request. The Worker refuses to serve anything without a token rather than leaving
your data open.

### 4. Use a custom domain

**Settings** → **Domains & Routes** → **Add** → **Custom domain**.

Cloudflare's Cache API silently does nothing on `workers.dev` subdomains, so without a
custom domain neither the response cache nor the access token cache works, and you sign
a fresh JWT on every single call.

---

## Connecting your AI assistant

### Claude (web, desktop and mobile)

**Settings** → **Connectors** → **Add custom connector**.

| Field | Value |
| --- | --- |
| URL | `https://your-worker-domain/mcp` |
| Authentication | **None** |

Then **Add header**: name `x-api-key`, value your `MCP_TOKEN`, Required ticked.

**Authentication must be None.** This server uses an API key, not OAuth. The
`authorization` header is greyed out because Claude reserves it for its own OAuth bearer
token, hence `x-api-key`.

### Claude Code

```bash
claude mcp add --transport http gsc https://your-worker-domain/mcp \
  --header "x-api-key: YOUR_MCP_TOKEN"
```

### Clients that only speak stdio

```json
{
  "mcpServers": {
    "search-console": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://your-worker-domain/mcp",
        "--header", "x-api-key:YOUR_MCP_TOKEN"
      ]
    }
  }
}
```

### Check it worked

Ask: *"list my Search Console properties"*. If that returns an empty list, step 5 of the
Google setup has not been done for any property.

---

## Tools

| Tool | What it does |
| --- | --- |
| `list_sites` | Every property the service account can reach, with permission level |
| `get_top_queries` | Queries bringing the most clicks, optionally filtered to one section of the site |
| `get_top_pages` | Pages getting the most clicks and impressions |
| `get_search_analytics` | The full performance report: any dimensions, filters, search types |
| `compare_periods` | Two ranges with deltas, marking queries won and lost rather than merely moved |
| `inspect_url` | Index status for one URL: indexed or not, last crawl, chosen canonical, mobile usability |
| `batch_inspect_urls` | The same for up to 20 URLs at once, with a summary of how many are indexed |
| `check_indexing_issues` | Inspects a set of URLs and reports only the problems, grouped by cause |
| `list_sitemaps` | Sitemaps Google knows about, with URL counts and errors |
| `get_sitemap` | Detail for one sitemap |

**Write tools** (`submit_sitemap`, `delete_sitemap`) are off by default. To enable, set
the `ENABLE_WRITES` variable to `true` (a plain variable, not a secret). They also need
**Full** permission on the property, not Restricted.

When writes are off, the Worker requests Google's read-only scope, so it cannot modify
anything even in principle. `delete_sitemap` additionally requires `confirm: true`.

### Dates

Search Console data lags two to three days. Ranges therefore end three days ago by
default, since a range ending today returns little or nothing and looks like a broken
tool. Use `days` for a relative window, or `start_date` and `end_date` for an explicit
one.

---

## Troubleshooting

**`list_sites` returns an empty list.** The service account has not been added to any
property. See step 5 of the Google setup. This is by far the most common problem.

**403 on one property but not others.** The service account was not added to that
particular property, or was added with Restricted permission and you are trying to write.

**404 on a property.** The identifier is wrong. Domain properties are
`sc-domain:example.com`. URL-prefix properties are `https://example.com/`, with the
trailing slash, and `https://example.com` is a different property from
`https://www.example.com`. Run `list_sites` for the exact strings.

**"Google refused the service account credentials."** The email or private key is wrong.
Re-copy both from the JSON. If you lost the file, create a new key and delete the old one.

**"GOOGLE_PRIVATE_KEY does not look like a PEM private key."** The value was truncated on
paste. It must include both the `-----BEGIN PRIVATE KEY-----` and
`-----END PRIVATE KEY-----` lines.

**Empty results for a recent date range.** Reporting lag. Try a range ending a week ago,
or pass `data_state: "all"` to include fresh but incomplete data.

**Results seem stale.** Responses are cached for 5 minutes. Search Console data only
updates daily, so this rarely matters.

---

## Development

```bash
npm install
npm run typecheck
npm run dev     # needs a .dev.vars file, gitignored
npm run tail    # live logs from the deployed worker
```

## Licence

Free and MIT licensed. Provided as-is, with no warranty of any kind and no liability
accepted, as set out in [LICENSE](LICENSE).

You deploy and run this in your own Cloudflare account, so your service account
credentials, your usage and anything the tools do to your Search Console properties
remain your responsibility. Enabling the write tools means an AI assistant can submit
and delete sitemaps on your properties, so read that section before turning them on.

Maintained in spare time, so issues and pull requests are very welcome but may not get a
fast response.
