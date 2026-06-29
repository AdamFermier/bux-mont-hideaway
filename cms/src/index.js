import {
  loginPage, otpPage,
  handleAuthRequest, handleAuthVerify,
  getSession, clearSession,
} from './auth.js';
import { generateDraft } from './claude.js';
import { publishPost } from './github.js';
import { getSite, listSites, createSite, listUsersForSite, addUserToSite, removeUserFromSite } from './db.js';
import { handleReaderRequestOTP, handleReaderVerifyOTP, handleReaderValidate } from './reader-auth.js';
import { exportContent, exportHTML, transferRepo } from './exporter.js';
import { provisionSite } from './provisioner.js';

import UI_HTML from './ui.html';
import ADMIN_HTML from './admin.html';

const ADMIN_SUBDOMAIN = 'admin';

function getSiteId(request) {
  const host = request.headers.get('host') || '';
  const sub = host.split('.')[0];
  return sub || null;
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function json(data, status = 200) {
  return Response.json(data, { status });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const siteId = getSiteId(request);
    const isAdmin = siteId === ADMIN_SUBDOMAIN;

    // ── Root domain — redirect to admin ───────────────────────────────────
    if (!siteId || siteId === 'scribe-it') {
      return Response.redirect('https://admin.scribe-it.app', 302);
    }

    // ── Reader auth routes (no CMS session required — called by Pages middleware) ─
    // These are hit from private site middleware, not from browsers directly.
    if (path === '/api/reader/request-otp' && request.method === 'POST') {
      return handleReaderRequestOTP(request, env);
    }
    if (path === '/api/reader/verify-otp' && request.method === 'POST') {
      return handleReaderVerifyOTP(request, env);
    }
    if (path === '/api/reader/validate' && request.method === 'GET') {
      return handleReaderValidate(request, env);
    }

    // ── Resolve site (non-admin) ───────────────────────────────────────────
    let site = null;
    if (!isAdmin) {
      site = await getSite(env.DB, siteId);
      if (!site) {
        return html(`<h1>Site not found</h1><p>No site configured for <code>${escHtml(siteId)}</code>.</p>`, 404);
      }
    }

    const siteName = isAdmin ? 'Scribe-It Admin' : site.name;

    // ── Auth routes (no session required) ─────────────────────────────────
    if (path === '/auth/login' || path === '/auth/login/') {
      return html(loginPage(siteName));
    }

    if (path === '/auth/request' && request.method === 'POST') {
      return handleAuthRequest(request, env, siteId, siteName, isAdmin);
    }

    if (path === '/auth/verify' && request.method === 'POST') {
      return handleAuthVerify(request, env, siteId, isAdmin);
    }

    // ── Session gate ───────────────────────────────────────────────────────
    const session = await getSession(request, env);
    if (!session || session.site_id !== siteId) {
      if (path.startsWith('/api/')) return new Response('Unauthorized', { status: 401 });
      return html(loginPage(siteName));
    }

    // ── Logout ─────────────────────────────────────────────────────────────
    if (path === '/auth/logout') {
      if (session.token) await env.SESSIONS.delete(session.token);
      return clearSession();
    }

    // ══════════════════════════════════════════════════════════════════════
    // ADMIN ROUTES
    // ══════════════════════════════════════════════════════════════════════
    if (isAdmin) {
      if (session.email !== (env.ADMIN_EMAIL || '').toLowerCase()) {
        return new Response('Forbidden', { status: 403 });
      }

      if (path === '/' || path === '') {
        return html(ADMIN_HTML);
      }

      // List sites
      if (path === '/api/admin/sites' && request.method === 'GET') {
        return json(await listSites(env.DB));
      }

      // Create site (automated provisioning)
      if (path === '/api/admin/sites' && request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
        const { id, name, custom_domain, visibility = 'public' } = body;
        if (!id || !name) return new Response('Missing required fields: id, name', { status: 400 });
        if (!/^[a-z0-9-]+$/.test(id)) {
          return new Response('Slug must be lowercase letters, numbers, hyphens only', { status: 400 });
        }
        try {
          const result = await provisionSite(env, { id, name, customDomain: custom_domain, visibility });
          return json({ ok: true, ...result });
        } catch (err) {
          console.error('provisionSite error:', err);
          return new Response(`Site creation failed: ${err.message}`, { status: 500 });
        }
      }

      // List users for site
      if (path.match(/^\/api\/admin\/sites\/([^/]+)\/users$/) && request.method === 'GET') {
        const sid = path.split('/')[4];
        return json(await listUsersForSite(env.DB, sid));
      }

      // Add user to site
      if (path.match(/^\/api\/admin\/sites\/([^/]+)\/users$/) && request.method === 'POST') {
        const sid = path.split('/')[4];
        let body;
        try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
        await addUserToSite(env.DB, sid, body.email, body.display_name);
        return json({ ok: true });
      }

      // Remove user
      if (path.match(/^\/api\/admin\/sites\/([^/]+)\/users\/(\d+)$/) && request.method === 'DELETE') {
        const parts = path.split('/');
        const sid = parts[4];
        const uid = parts[6];
        await removeUserFromSite(env.DB, sid, uid);
        return json({ ok: true });
      }

      // Transfer repo to target GitHub account (admin-triggered on customer request)
      if (path.match(/^\/api\/admin\/sites\/([^/]+)\/transfer$/) && request.method === 'POST') {
        const sid = path.split('/')[4];
        let body;
        try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
        const { target_owner } = body;
        if (!target_owner) return new Response('Missing target_owner', { status: 400 });
        const targetSite = await getSite(env.DB, sid);
        if (!targetSite) return new Response('Site not found', { status: 404 });
        try {
          await transferRepo(env, targetSite, target_owner);
          await env.DB.prepare('UPDATE sites SET transfer_requested_at = ? WHERE id = ?')
            .bind(new Date().toISOString(), sid).run();
          return json({ ok: true });
        } catch (err) {
          return new Response(`Transfer failed: ${err.message}`, { status: 500 });
        }
      }

      return new Response('Not found', { status: 404 });
    }

    // ══════════════════════════════════════════════════════════════════════
    // CMS ROUTES (per-site)
    // ══════════════════════════════════════════════════════════════════════
    if (path === '/' || path === '') {
      const pageHtml = UI_HTML
        .replace('__SITE_NAME__', escHtml(site.name))
        .replace('__USER_NAME__', escHtml(session.display_name || session.email));
      return html(pageHtml);
    }

    // Generate draft
    if (path === '/api/generate' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
      const { type, notes, photoCount = 0 } = body;
      if (!notes || !['quick', 'event'].includes(type)) {
        return new Response('Invalid request', { status: 400 });
      }
      try {
        const draft = await generateDraft(env, type, notes.slice(0, 4000), photoCount);
        return json(draft);
      } catch (err) {
        console.error('generateDraft:', err);
        return new Response(`AI generation failed: ${err.message}`, { status: 500 });
      }
    }

    // Publish
    if (path === '/api/publish' && request.method === 'POST') {
      let formData;
      try { formData = await request.formData(); } catch { return new Response('Invalid form data', { status: 400 }); }

      const type = formData.get('type');
      const title = (formData.get('title') || '').trim();
      const body = (formData.get('body') || '').trim();
      if (!title || !body || !['quick', 'event'].includes(type)) {
        return new Response('Missing title, body, or type', { status: 400 });
      }

      const photos = [];
      for (const [key, value] of formData.entries()) {
        if (key.startsWith('photo_') && value instanceof File) {
          const ab = await value.arrayBuffer();
          const b64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
          const ext = (value.name.split('.').pop() || 'jpg').toLowerCase()
            .replace(/^(heic|heif|jpeg)$/, () => 'jpg');
          photos.push({ data: b64, ext });
        }
      }

      try {
        const result = await publishPost(env, {
          repo: site.github_repo,
          branch: site.github_branch,
          type, title, description: '', body,
          authorName: session.display_name || session.email,
          photos,
        });
        return json({ ok: true, slug: result.slug });
      } catch (err) {
        console.error('publishPost:', err);
        return new Response(`Publish failed: ${err.message}`, { status: 500 });
      }
    }

    // Export content (markdown zip)
    if (path === '/export/content' && request.method === 'GET') {
      try {
        return await exportContent(env, site);
      } catch (err) {
        return new Response(`Export failed: ${err.message}`, { status: 500 });
      }
    }

    // Export site info (HTML download instructions)
    if (path === '/export/html' && request.method === 'GET') {
      try {
        return await exportHTML(env, site);
      } catch (err) {
        return new Response(`Export failed: ${err.message}`, { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  },
};

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
