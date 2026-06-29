const GH_API = 'https://api.github.com';
const CF_API = 'https://api.cloudflare.com/client/v4';
const ORG = 'scribe-it-sites';

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'scribe-it-cms/1.0',
    'Content-Type': 'application/json',
  };
}

async function gh(token, path, options = {}) {
  const res = await fetch(`${GH_API}${path}`, {
    ...options,
    headers: { ...ghHeaders(token), ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

// ── Sequence counter ──────────────────────────────────────────────────────

async function nextSeq(db) {
  await db.prepare('UPDATE seq SET next_val = next_val + 1 WHERE id = 1').run();
  const row = await db.prepare('SELECT next_val FROM seq WHERE id = 1').first();
  // Return the value before increment (we incremented, so subtract 1)
  return row.next_val - 1;
}

function seqToRepoName(seq) {
  return `site-${String(seq).padStart(6, '0')}`;
}

// ── GitHub repo creation ──────────────────────────────────────────────────

export async function createRepo(token, repoName) {
  return gh(token, `/orgs/${ORG}/repos`, {
    method: 'POST',
    body: JSON.stringify({
      name: repoName,
      private: true,
      auto_init: false,
      description: 'Scribe-It managed site',
    }),
  });
}

// Seed the new repo with a minimal Hugo structure via the GitHub API.
// If HUGO_TEMPLATE_REPO is set, copy content from there instead.
async function seedRepo(token, repoName, siteName, siteSlug) {
  const files = buildInitialFiles(siteName, siteSlug);

  // Create blobs
  const treeItems = [];
  for (const [path, content] of Object.entries(files)) {
    const blobRes = await gh(token, `/repos/${ORG}/${repoName}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: btoa(unescape(encodeURIComponent(content))), encoding: 'base64' }),
    });
    treeItems.push({ path, mode: '100644', type: 'blob', sha: blobRes.sha });
  }

  // Create tree
  const treeRes = await gh(token, `/repos/${ORG}/${repoName}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ tree: treeItems }),
  });

  // Create initial commit
  const commitRes = await gh(token, `/repos/${ORG}/${repoName}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: 'Initial site setup',
      tree: treeRes.sha,
      parents: [],
    }),
  });

  // Create main branch ref
  await gh(token, `/repos/${ORG}/${repoName}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'refs/heads/main', sha: commitRes.sha }),
  });

  return commitRes;
}

function buildInitialFiles(siteName, siteSlug) {
  const hugoConfig = `baseURL: "https://${siteSlug}.scribe-it.app/"
title: "${siteName.replace(/"/g, '\\"')}"
languageCode: en-us
defaultContentLanguage: en
enableEmoji: true

markup:
  goldmark:
    renderer:
      unsafe: true

params:
  description: "Welcome to ${siteName.replace(/"/g, '\\"')}"

taxonomies:
  category: categories
  tag: tags
`;

  const readme = `# ${siteName}

This site is managed by [Scribe-It](https://scribe-it.app).
Content is published automatically through the CMS.
`;

  const gitignore = `public/
.hugo_build.lock
resources/
`;

  const indexPage = `---
title: "Welcome"
date: ${new Date().toISOString().slice(0, 10)}
draft: false
---

Welcome to ${siteName}! Posts will appear here as they are published.
`;

  return {
    'hugo.yaml': hugoConfig,
    'README.md': readme,
    '.gitignore': gitignore,
    'content/_index.md': indexPage,
  };
}

// ── Cloudflare Pages project creation ─────────────────────────────────────

export async function createPagesProject(env, { repoName, siteSlug, customDomain }) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    throw new Error('CF_ACCOUNT_ID and CF_API_TOKEN secrets required for Pages provisioning');
  }

  const projectName = `scribe-it-${siteSlug}`;

  const res = await fetch(`${CF_API}/accounts/${env.CF_ACCOUNT_ID}/pages/projects`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: projectName,
      production_branch: 'main',
      source: {
        type: 'github',
        config: {
          owner: ORG,
          repo_name: repoName,
          production_branch: 'main',
          pr_comments_enabled: false,
          deployments_enabled: true,
        },
      },
      build_config: {
        build_command: 'hugo',
        destination_dir: 'public',
        root_dir: '',
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cloudflare Pages API ${res.status}: ${body}`);
  }
  const { result } = await res.json();
  return { projectName, subdomain: result.subdomain };
}

// ── Seed Pages Functions middleware (private sites only) ──────────────────

async function seedMiddleware(token, repoName, siteSlug, headSha, baseTreeSha) {
  const middlewareContent = getMiddlewareTemplate(siteSlug);

  const blobRes = await gh(token, `/repos/${ORG}/${repoName}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({
      content: btoa(unescape(encodeURIComponent(middlewareContent))),
      encoding: 'base64',
    }),
  });

  const treeRes = await gh(token, `/repos/${ORG}/${repoName}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: [{ path: 'functions/_middleware.js', mode: '100644', type: 'blob', sha: blobRes.sha }],
    }),
  });

  const commitRes = await gh(token, `/repos/${ORG}/${repoName}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: 'Add private site reader auth middleware',
      tree: treeRes.sha,
      parents: [headSha],
    }),
  });

  await gh(token, `/repos/${ORG}/${repoName}/git/refs/heads/main`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commitRes.sha }),
  });
}

function getMiddlewareTemplate(siteSlug) {
  // Inline the middleware template with placeholders replaced.
  // This avoids needing to import/bundle the template file at runtime.
  const CMS_WORKER_URL = `https://${siteSlug}.scribe-it.app`;
  const SITE_ID = siteSlug;

  return `// Auto-generated by Scribe-It provisioner. Do not edit manually.
const CMS_WORKER_URL = '${CMS_WORKER_URL}';
const SITE_ID = '${SITE_ID}';
const COOKIE_NAME = 'si_reader';
const COOKIE_TTL = 7 * 24 * 60 * 60;

export async function onRequest(ctx) {
  const { request, next } = ctx;
  const url = new URL(request.url);

  if (url.pathname === '/_auth/login') return loginPage(url.searchParams.get('error'));
  if (url.pathname === '/_auth/request' && request.method === 'POST') return handleRequest(request);
  if (url.pathname === '/_auth/verify'  && request.method === 'POST') return handleVerify(request);
  if (url.pathname === '/_auth/logout')  return logout();

  const token = getCookie(request, COOKIE_NAME);
  if (token) {
    const res = await fetch(\`\${CMS_WORKER_URL}/api/reader/validate?token=\${encodeURIComponent(token)}\`);
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.siteId === SITE_ID) return next();
    }
  }
  return loginPage();
}

async function handleRequest(request) {
  const form = await request.formData();
  const email = (form.get('email') || '').trim().toLowerCase();
  if (!email) return loginPage('Please enter a valid email address.');
  const res = await fetch(\`\${CMS_WORKER_URL}/api/reader/request-otp\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, siteId: SITE_ID }),
  });
  if (!res.ok) return loginPage((await res.text()) || 'Could not send sign-in email. Please try again.');
  return otpPage(email);
}

async function handleVerify(request) {
  const form = await request.formData();
  const email = (form.get('email') || '').trim().toLowerCase();
  const code  = (form.get('code')  || '').trim();
  if (!email || !code) return otpPage(email, 'Please enter the code from your email.');
  const res = await fetch(\`\${CMS_WORKER_URL}/api/reader/verify-otp\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, siteId: SITE_ID, code }),
  });
  if (!res.ok) return otpPage(email, 'Incorrect or expired code. Please try again.');
  const { token } = await res.json();
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/',
      'Set-Cookie': \`\${COOKIE_NAME}=\${token}; HttpOnly; Secure; SameSite=Lax; Max-Age=\${COOKIE_TTL}; Path=/\`,
    },
  });
}

function logout() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/_auth/login',
      'Set-Cookie': \`\${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/\`,
    },
  });
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const match = header.match(new RegExp(\`(?:^|;\\\\s*)\${name}=([^;]+)\`));
  return match ? match[1] : null;
}

function loginPage(error = null) {
  return html(\`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#f9fafb;display:flex;align-items:center;justify-content:center;min-height:100vh}
.c{background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);padding:2.5rem;width:100%;max-width:360px}
h1{font-size:1.3rem;margin-bottom:.5rem}p{color:#6b7280;font-size:.9rem;margin-bottom:1.25rem;line-height:1.5}
label{display:block;font-weight:600;font-size:.875rem;margin-bottom:.35rem}
input{width:100%;border:1.5px solid #d1d5db;border-radius:8px;padding:.7rem;font-size:1rem;outline:none}
input:focus{border-color:#2e7d52;box-shadow:0 0 0 3px rgba(46,125,82,.1)}
button{width:100%;margin-top:.9rem;background:#2e7d52;color:#fff;border:none;border-radius:8px;padding:.8rem;font-size:1rem;font-weight:600;cursor:pointer}
button:hover{background:#245f3f}
.err{background:#fee2e2;color:#991b1b;border-radius:8px;padding:.7rem;font-size:.875rem;margin-bottom:1rem}
</style></head><body><div class="c">
<h1>This site is private</h1>
<p>Enter your email address and we'll send you a sign-in code.</p>
\${error ? \`<div class="err">\${esc(error)}</div>\` : ''}
<form method="POST" action="/_auth/request">
  <label>Email address</label>
  <input type="email" name="email" required autocomplete="email" placeholder="you@example.com">
  <button type="submit">Send sign-in code</button>
</form>
</div></body></html>\`);
}

function otpPage(email, error = null) {
  return html(\`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Enter code</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#f9fafb;display:flex;align-items:center;justify-content:center;min-height:100vh}
.c{background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);padding:2.5rem;width:100%;max-width:360px}
h1{font-size:1.3rem;margin-bottom:.5rem}p{color:#6b7280;font-size:.9rem;margin-bottom:1.25rem;line-height:1.5}
label{display:block;font-weight:600;font-size:.875rem;margin-bottom:.35rem}
input{width:100%;border:1.5px solid #d1d5db;border-radius:8px;padding:.7rem;font-size:1.5rem;letter-spacing:.3rem;text-align:center;outline:none}
input:focus{border-color:#2e7d52;box-shadow:0 0 0 3px rgba(46,125,82,.1)}
button{width:100%;margin-top:.9rem;background:#2e7d52;color:#fff;border:none;border-radius:8px;padding:.8rem;font-size:1rem;font-weight:600;cursor:pointer}
button:hover{background:#245f3f}
.err{background:#fee2e2;color:#991b1b;border-radius:8px;padding:.7rem;font-size:.875rem;margin-bottom:1rem}
.back{display:block;text-align:center;margin-top:.9rem;color:#6b7280;font-size:.85rem}a{color:#2e7d52}
</style></head><body><div class="c">
<h1>Check your email</h1>
<p>We sent a 6-digit code to <strong>\${esc(email)}</strong>. It expires in 5 minutes.</p>
\${error ? \`<div class="err">\${esc(error)}</div>\` : ''}
<form method="POST" action="/_auth/verify">
  <input type="hidden" name="email" value="\${esc(email)}">
  <label>Sign-in code</label>
  <input type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code" placeholder="000000">
  <button type="submit">Sign in</button>
</form>
<a class="back" href="/_auth/login">Use a different email</a>
</div></body></html>\`);
}

function html(body) {
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
`;
}

// ── Main provisioner entry point ──────────────────────────────────────────

export async function provisionSite(env, { id, name, customDomain, visibility = 'public' }) {
  const token = env.GITHUB_ORG_TOKEN;
  if (!token) throw new Error('GITHUB_ORG_TOKEN secret not set');

  // 1. Get next seq number
  const seq = await nextSeq(env.DB);
  const repoName = seqToRepoName(seq);
  const fullRepo = `${ORG}/${repoName}`;

  // 2. Create private GitHub repo
  await createRepo(token, repoName);

  // 3. Seed initial Hugo structure
  await seedRepo(token, repoName, name, id);

  // 4. If private, add Pages Functions middleware
  if (visibility === 'private') {
    const ref = await (await fetch(`${GH_API}/repos/${fullRepo}/git/ref/heads/main`, {
      headers: ghHeaders(token),
    })).json();
    const headSha = ref.object.sha;
    const commit = await (await fetch(`${GH_API}/repos/${fullRepo}/git/commits/${headSha}`, {
      headers: ghHeaders(token),
    })).json();
    await seedMiddleware(token, repoName, id, headSha, commit.tree.sha);
  }

  // 5. Create Cloudflare Pages project (only if CF secrets are configured)
  let pagesProject = null;
  if (env.CF_ACCOUNT_ID && env.CF_API_TOKEN) {
    try {
      const pages = await createPagesProject(env, { repoName, siteSlug: id, customDomain });
      pagesProject = pages.projectName;
    } catch (e) {
      console.warn('Pages project creation failed (non-fatal):', e.message);
    }
  }

  // 6. Save to D1
  await env.DB.prepare(`
    INSERT INTO sites (id, name, github_repo, github_branch, repo_seq, visibility, custom_domain, pages_project)
    VALUES (?, ?, ?, 'main', ?, ?, ?, ?)
  `).bind(id, name, fullRepo, seq, visibility, customDomain || null, pagesProject).run();

  return { repoName, fullRepo, pagesProject };
}
