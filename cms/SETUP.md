# CMS Setup Guide

One-time setup so your parents can blog with AI assistance.

## Prerequisites

- Cloudflare account with Workers enabled
- `wrangler` CLI installed: `npm install -g wrangler` then `wrangler login`

---

## Step 1 — Create the KV namespace

```bash
cd cms
npm install
wrangler kv:namespace create SESSIONS
wrangler kv:namespace create SESSIONS --preview
```

Copy the two IDs printed into `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "SESSIONS"
id = "PASTE_ID_HERE"
preview_id = "PASTE_PREVIEW_ID_HERE"
```

---

## Step 2 — First deploy (to get your workers.dev URL)

```bash
wrangler deploy
```

Note the URL printed, e.g. `https://bux-mont-hideaway-cms.YOUR_ACCOUNT.workers.dev`

Update `wrangler.toml`:
```toml
[vars]
BASE_URL = "https://bux-mont-hideaway-cms.YOUR_ACCOUNT.workers.dev"
```

---

## Step 3 — Google OAuth setup

1. Go to https://console.cloud.google.com/
2. Create a project (or use an existing one)
3. APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID
4. Application type: **Web application**
5. Authorized redirect URIs: add `https://bux-mont-hideaway-cms.YOUR_ACCOUNT.workers.dev/auth/callback`
6. Copy Client ID and Client Secret

```bash
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
```

---

## Step 4 — GitHub Personal Access Token

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Repository access: `AdamFermier/bux-mont-hideaway` only
3. Permissions → Repository permissions → **Contents: Read and write**
4. Generate token, copy it

```bash
wrangler secret put GITHUB_TOKEN
```

---

## Step 5 — Anthropic API key

Get your API key from https://console.anthropic.com/

```bash
wrangler secret put ANTHROPIC_API_KEY
```

---

## Step 6 — Allowed emails and session secret

```bash
# Comma-separated Gmail addresses for your parents
wrangler secret put ALLOWED_EMAILS
# Enter: mom@gmail.com,dad@gmail.com

# Generate a random secret (or use any long random string)
wrangler secret put SESSION_SECRET
# Enter any 32+ character random string

# The workers.dev URL from Step 2
wrangler secret put BASE_URL
# Enter: https://bux-mont-hideaway-cms.YOUR_ACCOUNT.workers.dev
```

---

## Step 7 — Final deploy

```bash
wrangler deploy
```

---

## Testing locally

```bash
wrangler dev
```

Visit http://localhost:8787 — Google OAuth will still use your live redirect URI so you need to also add `http://localhost:8787/auth/callback` to your Google OAuth client's allowed URIs.

---

## How it works for your parents

1. They visit the Worker URL
2. They click "Sign in with Google" and use their Gmail account
3. They choose "Quick Post" or "Event Story"
4. They type some notes about what they want to share
5. For Event Stories, they drag in photos
6. They click "Help me write this" — Claude drafts the post
7. They edit if they want, then click "Publish to Site"
8. The site rebuilds automatically via GitHub Actions (~2 minutes)
