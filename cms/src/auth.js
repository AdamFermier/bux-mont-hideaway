const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

const SESSION_COOKIE = 'bm_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function callbackUrl(env) {
  return `${env.BASE_URL}/auth/callback`;
}

export async function handleLogin(env) {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(env),
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
  });
  return Response.redirect(`${GOOGLE_AUTH_URL}?${params}`, 302);
}

export async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) {
    return new Response('Missing OAuth code', { status: 400 });
  }

  // Exchange code for tokens
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl(env),
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    return new Response('Failed to exchange OAuth code', { status: 500 });
  }
  const { access_token } = await tokenRes.json();

  // Get user info
  const userRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!userRes.ok) {
    return new Response('Failed to fetch user info', { status: 500 });
  }
  const { email, name } = await userRes.json();

  // Check allowlist
  const allowed = (env.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase());
  if (!allowed.includes(email.toLowerCase())) {
    return new Response(accessDeniedHtml(email), {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // Create session
  const sessionToken = crypto.randomUUID();
  await env.SESSIONS.put(
    sessionToken,
    JSON.stringify({ email, name }),
    { expirationTtl: SESSION_TTL_SECONDS }
  );

  return new Response(null, {
    status: 302,
    headers: {
      Location: '/',
      'Set-Cookie': `${SESSION_COOKIE}=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}; Path=/`,
    },
  });
}

export async function handleLogout(env, sessionToken) {
  if (sessionToken) {
    await env.SESSIONS.delete(sessionToken);
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/auth/login',
      'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`,
    },
  });
}

// Returns session {email, name} or null
export async function getSession(request, env) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  const token = match[1];
  const raw = await env.SESSIONS.get(token);
  if (!raw) return null;
  return { ...JSON.parse(raw), token };
}

function accessDeniedHtml(email) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Access Denied</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8f9fa}
.box{text-align:center;padding:2rem;max-width:400px}</style></head>
<body><div class="box">
<h2>Access Denied</h2>
<p>${email} is not authorized to use this tool.</p>
<p>Please ask Adam to add your email to the allowed list.</p>
<a href="/auth/login">Try a different account</a>
</div></body></html>`;
}
