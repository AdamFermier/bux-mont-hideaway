import { saveOTP, verifyOTP, getUserForSite } from './db.js';
import { sendOTPEmail } from './email.js';

const SESSION_COOKIE = 'si_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function loginPage(siteName, error = null) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — ${escHtml(siteName)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f9fafb;
     display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.08);
      padding:2.5rem;width:100%;max-width:380px}
.logo{font-size:1.1rem;font-weight:700;color:#2e7d52;margin-bottom:0.25rem}
h1{font-size:1.4rem;margin-bottom:0.5rem}
p{color:#6b7280;font-size:0.9rem;margin-bottom:1.5rem;line-height:1.5}
label{display:block;font-weight:600;font-size:0.9rem;margin-bottom:0.4rem}
input{width:100%;border:1.5px solid #d1d5db;border-radius:8px;padding:0.75rem;
      font-size:1rem;outline:none;transition:border-color 0.15s}
input:focus{border-color:#2e7d52;box-shadow:0 0 0 3px rgba(46,125,82,0.1)}
button{width:100%;margin-top:1rem;background:#2e7d52;color:#fff;border:none;
       border-radius:8px;padding:0.85rem;font-size:1rem;font-weight:600;cursor:pointer}
button:hover{background:#245f3f}
.err{background:#fee2e2;color:#991b1b;border-radius:8px;padding:0.75rem;
     font-size:0.875rem;margin-bottom:1rem}
</style></head>
<body><div class="card">
  <div class="logo">✍️ Scribe-It</div>
  <h1>${escHtml(siteName)}</h1>
  <p>Enter your email address and we'll send you a sign-in code.</p>
  ${error ? `<div class="err">${escHtml(error)}</div>` : ''}
  <form method="POST" action="/auth/request">
    <label for="email">Email address</label>
    <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@example.com">
    <button type="submit">Send sign-in code</button>
  </form>
</div></body></html>`;
}

export function otpPage(siteName, email, error = null) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Enter code — ${escHtml(siteName)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f9fafb;
     display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.08);
      padding:2.5rem;width:100%;max-width:380px}
.logo{font-size:1.1rem;font-weight:700;color:#2e7d52;margin-bottom:0.25rem}
h1{font-size:1.4rem;margin-bottom:0.5rem}
p{color:#6b7280;font-size:0.9rem;margin-bottom:1.5rem;line-height:1.5}
label{display:block;font-weight:600;font-size:0.9rem;margin-bottom:0.4rem}
input{width:100%;border:1.5px solid #d1d5db;border-radius:8px;padding:0.75rem;
      font-size:1.5rem;letter-spacing:0.3rem;text-align:center;outline:none;transition:border-color 0.15s}
input:focus{border-color:#2e7d52;box-shadow:0 0 0 3px rgba(46,125,82,0.1)}
button{width:100%;margin-top:1rem;background:#2e7d52;color:#fff;border:none;
       border-radius:8px;padding:0.85rem;font-size:1rem;font-weight:600;cursor:pointer}
button:hover{background:#245f3f}
.err{background:#fee2e2;color:#991b1b;border-radius:8px;padding:0.75rem;
     font-size:0.875rem;margin-bottom:1rem}
.back{display:block;text-align:center;margin-top:1rem;color:#6b7280;font-size:0.85rem}
a{color:#2e7d52}
</style></head>
<body><div class="card">
  <div class="logo">✍️ Scribe-It</div>
  <h1>Check your email</h1>
  <p>We sent a 6-digit code to <strong>${escHtml(email)}</strong>. It expires in 5 minutes.</p>
  ${error ? `<div class="err">${escHtml(error)}</div>` : ''}
  <form method="POST" action="/auth/verify">
    <input type="hidden" name="email" value="${escHtml(email)}">
    <label for="code">Sign-in code</label>
    <input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9]{6}"
           maxlength="6" required autocomplete="one-time-code" placeholder="000000">
    <button type="submit">Sign in</button>
  </form>
  <a class="back" href="/auth/login">Use a different email</a>
</div></body></html>`;
}

export async function handleAuthRequest(request, env, siteId, siteName, isAdmin) {
  const body = await request.formData();
  const email = (body.get('email') || '').trim().toLowerCase();

  if (!email || !email.includes('@')) {
    return html(loginPage(siteName, 'Please enter a valid email address.'));
  }

  // Check authorization
  if (isAdmin) {
    if (email !== (env.ADMIN_EMAIL || '').toLowerCase()) {
      return html(loginPage(siteName, 'That email is not authorized for the admin panel.'));
    }
  } else {
    const user = await getUserForSite(env.DB, siteId, email);
    if (!user) {
      return html(loginPage(siteName, 'That email is not authorized for this site. Ask your site admin to add you.'));
    }
  }

  const code = generateCode();
  await saveOTP(env.DB, siteId, email, code);

  try {
    await sendOTPEmail(env, { to: email, code, siteName });
  } catch (err) {
    console.error('Email send failed:', err);
    return html(loginPage(siteName, 'Failed to send sign-in email. Please try again.'));
  }

  return html(otpPage(siteName, email));
}

export async function handleAuthVerify(request, env, siteId, isAdmin) {
  const body = await request.formData();
  const email = (body.get('email') || '').trim().toLowerCase();
  const code = (body.get('code') || '').trim();
  const siteName = isAdmin ? 'Admin Panel' : siteId;

  if (!email || !code) {
    return html(otpPage(siteName, email, 'Please enter the code from your email.'));
  }

  const valid = await verifyOTP(env.DB, siteId, email, code);
  if (!valid) {
    return html(otpPage(siteName, email, 'That code is incorrect or has expired. Please try again.'));
  }

  // Get display name
  let displayName = email;
  if (!isAdmin) {
    const user = await getUserForSite(env.DB, siteId, email);
    displayName = user?.display_name || email;
  } else {
    displayName = 'Admin';
  }

  const token = crypto.randomUUID();
  await env.SESSIONS.put(
    token,
    JSON.stringify({ email, site_id: siteId, display_name: displayName }),
    { expirationTtl: 7 * 24 * 60 * 60 }
  );

  return new Response(null, {
    status: 302,
    headers: {
      Location: '/',
      'Set-Cookie': `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}; Path=/`,
    },
  });
}

export async function getSession(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  const raw = await env.SESSIONS.get(match[1]);
  if (!raw) return null;
  return { ...JSON.parse(raw), token: match[1] };
}

export function clearSession(token) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/auth/login',
      'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`,
    },
  });
}

function html(body) {
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
