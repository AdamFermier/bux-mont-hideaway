// Cloudflare Pages Functions middleware — seeded into private site repos at creation.
// This file is committed as functions/_middleware.js in the Hugo repo.
// It intercepts every request to the site and enforces email OTP authentication.
// The CMS_WORKER_URL variable is replaced at provisioning time.

const CMS_WORKER_URL = '__CMS_WORKER_URL__'; // e.g. https://bux-mont.scribe-it.app
const SITE_ID = '__SITE_ID__';               // e.g. bux-mont
const COOKIE_NAME = 'si_reader';
const COOKIE_TTL = 7 * 24 * 60 * 60;

export async function onRequest(ctx) {
  const { request, next, env } = ctx;
  const url = new URL(request.url);

  // ── Auth endpoints handled by this middleware ─────────────────────────
  if (url.pathname === '/_auth/login') return loginPage(url.searchParams.get('error'));
  if (url.pathname === '/_auth/request' && request.method === 'POST') return handleRequest(request);
  if (url.pathname === '/_auth/verify'  && request.method === 'POST') return handleVerify(request);
  if (url.pathname === '/_auth/logout')  return logout();

  // ── Validate session ─────────────────────────────────────────────────
  const token = getCookie(request, COOKIE_NAME);
  if (token) {
    const res = await fetch(`${CMS_WORKER_URL}/api/reader/validate?token=${encodeURIComponent(token)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.siteId === SITE_ID) {
        return next(); // authenticated — serve the static site
      }
    }
  }

  // ── Not authenticated ─────────────────────────────────────────────────
  return loginPage();
}

async function handleRequest(request) {
  const form = await request.formData();
  const email = (form.get('email') || '').trim().toLowerCase();
  if (!email) return loginPage('Please enter a valid email address.');

  const res = await fetch(`${CMS_WORKER_URL}/api/reader/request-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, siteId: SITE_ID }),
  });

  if (!res.ok) {
    const msg = await res.text();
    return loginPage(msg || 'Could not send sign-in email. Please try again.');
  }

  return otpPage(email);
}

async function handleVerify(request) {
  const form = await request.formData();
  const email = (form.get('email') || '').trim().toLowerCase();
  const code  = (form.get('code')  || '').trim();
  if (!email || !code) return otpPage(email, 'Please enter the code from your email.');

  const res = await fetch(`${CMS_WORKER_URL}/api/reader/verify-otp`, {
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
      'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_TTL}; Path=/`,
    },
  });
}

function logout() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/_auth/login',
      'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`,
    },
  });
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

// ── Inline HTML pages (no external dependencies) ─────────────────────────

function loginPage(error = null) {
  return html(`<!DOCTYPE html>
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
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="POST" action="/_auth/request">
  <label>Email address</label>
  <input type="email" name="email" required autocomplete="email" placeholder="you@example.com">
  <button type="submit">Send sign-in code</button>
</form>
</div></body></html>`);
}

function otpPage(email, error = null) {
  return html(`<!DOCTYPE html>
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
<p>We sent a 6-digit code to <strong>${esc(email)}</strong>. It expires in 5 minutes.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="POST" action="/_auth/verify">
  <input type="hidden" name="email" value="${esc(email)}">
  <label>Sign-in code</label>
  <input type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code" placeholder="000000">
  <button type="submit">Sign in</button>
</form>
<a class="back" href="/_auth/login">Use a different email</a>
</div></body></html>`);
}

function html(body) {
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
