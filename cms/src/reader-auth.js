import { getUserForSite } from './db.js';
import { saveOTP, verifyOTP } from './db.js';
import { sendOTPEmail } from './email.js';

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── JWT-style signed tokens (HMAC-SHA256, no library needed) ──────────────

async function getKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signReaderToken(secret, { email, siteId }) {
  const payload = { email, siteId, exp: Date.now() + TOKEN_TTL_MS };
  const data = JSON.stringify(payload);
  const key = await getKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return btoa(data) + '.' + b64;
}

export async function verifyReaderToken(secret, token) {
  try {
    const [b64Data, b64Sig] = token.split('.');
    if (!b64Data || !b64Sig) return null;
    const data = atob(b64Data);
    const sig = Uint8Array.from(atob(b64Sig), c => c.charCodeAt(0));
    const key = await getKey(secret);
    const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data));
    if (!valid) return null;
    const payload = JSON.parse(data);
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── CMS Worker API routes called by the Pages middleware ──────────────────

export async function handleReaderRequestOTP(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }
  const { email, siteId } = body;
  if (!email || !siteId) return err('Missing email or siteId');

  const user = await getUserForSite(env.DB, siteId, email);
  if (!user) return err('That email is not authorized for this site.', 403);

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await saveOTP(env.DB, siteId, email.toLowerCase(), code);

  // Get site name for email
  const site = await env.DB.prepare('SELECT name FROM sites WHERE id = ?').bind(siteId).first();
  const siteName = site?.name || siteId;

  try {
    await sendOTPEmail(env, { to: email, code, siteName });
  } catch (e) {
    console.error('reader OTP email failed:', e);
    return err('Failed to send sign-in email. Please try again.');
  }

  return ok({ sent: true });
}

export async function handleReaderVerifyOTP(request, env) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }
  const { email, siteId, code } = body;
  if (!email || !siteId || !code) return err('Missing fields');

  const valid = await verifyOTP(env.DB, siteId, email, code);
  if (!valid) return err('Incorrect or expired code.', 401);

  const token = await signReaderToken(env.SESSION_SECRET, { email: email.toLowerCase(), siteId });
  return ok({ token });
}

export async function handleReaderValidate(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) return ok({ ok: false });

  const payload = await verifyReaderToken(env.SESSION_SECRET, token);
  if (!payload) return ok({ ok: false });

  return ok({ ok: true, email: payload.email, siteId: payload.siteId });
}

function ok(data) { return Response.json(data); }
function err(msg, status = 400) { return new Response(msg, { status }); }
