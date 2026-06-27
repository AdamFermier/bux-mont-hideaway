import { handleLogin, handleCallback, handleLogout, getSession } from './auth.js';
import { generateDraft } from './claude.js';
import { publishPost } from './github.js';

// ui.html is inlined at deploy time via wrangler's text module
import UI_HTML from './ui.html';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── Auth routes (no session required) ──────────────────────────────────
    if (path === '/auth/login' || path === '/auth/login/') {
      return handleLogin(env);
    }
    if (path === '/auth/callback') {
      return handleCallback(request, env);
    }

    // ── Session gate ───────────────────────────────────────────────────────
    const session = await getSession(request, env);

    if (!session) {
      if (path.startsWith('/api/')) {
        return new Response('Unauthorized', { status: 401 });
      }
      return Response.redirect(`${env.BASE_URL}/auth/login`, 302);
    }

    // ── Logout ─────────────────────────────────────────────────────────────
    if (path === '/auth/logout') {
      return handleLogout(env, session.token);
    }

    // ── CMS UI ─────────────────────────────────────────────────────────────
    if (path === '/' || path === '') {
      const html = UI_HTML.replace('__NAME__', escapeHtml(session.name || session.email));
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // ── API: generate draft ────────────────────────────────────────────────
    if (path === '/api/generate' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }

      const { type, notes, photoCount = 0 } = body;
      if (!notes || typeof notes !== 'string') {
        return new Response('Missing notes', { status: 400 });
      }
      if (!['quick', 'event'].includes(type)) {
        return new Response('Invalid type', { status: 400 });
      }

      try {
        const draft = await generateDraft(env, type, notes.slice(0, 4000), photoCount);
        return Response.json(draft);
      } catch (err) {
        console.error('generateDraft error:', err);
        return new Response(`AI generation failed: ${err.message}`, { status: 500 });
      }
    }

    // ── API: publish ───────────────────────────────────────────────────────
    if (path === '/api/publish' && request.method === 'POST') {
      let formData;
      try {
        formData = await request.formData();
      } catch {
        return new Response('Invalid form data', { status: 400 });
      }

      const type = formData.get('type');
      const title = (formData.get('title') || '').trim();
      const body = (formData.get('body') || '').trim();

      if (!title || !body) {
        return new Response('Missing title or body', { status: 400 });
      }
      if (!['quick', 'event'].includes(type)) {
        return new Response('Invalid type', { status: 400 });
      }

      // Collect photos from FormData
      const photos = [];
      for (const [key, value] of formData.entries()) {
        if (key.startsWith('photo_') && value instanceof File) {
          const arrayBuffer = await value.arrayBuffer();
          const b64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
          const ext = (value.name.split('.').pop() || 'jpg').toLowerCase()
            .replace('heic', 'jpg').replace('heif', 'jpg').replace('jpeg', 'jpg');
          photos.push({ data: b64, ext });
        }
      }

      try {
        const result = await publishPost(env, {
          type,
          title,
          description: '',
          body,
          authorName: session.name || session.email,
          photos,
        });
        return Response.json({ ok: true, slug: result.slug });
      } catch (err) {
        console.error('publishPost error:', err);
        return new Response(`Publish failed: ${err.message}`, { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  },
};

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
