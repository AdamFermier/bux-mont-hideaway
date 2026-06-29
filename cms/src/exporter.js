const GH_API = 'https://api.github.com';
const ORG = 'scribe-it-sites';

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'scribe-it-cms/1.0',
  };
}

// ── Minimal ZIP builder (no external deps) ────────────────────────────────

function u32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
function u16le(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

function crc32(data) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  // files: Array<{name: string, data: Uint8Array}>
  const enc = new TextEncoder();
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const name = enc.encode(file.name);
    const data = file.data;
    const crc = crc32(data);
    const local = new Uint8Array([
      0x50,0x4b,0x03,0x04, // local file header sig
      ...u16le(20),         // version needed
      ...u16le(0),          // flags
      ...u16le(0),          // compression (stored)
      ...u16le(0),          // mod time
      ...u16le(0),          // mod date
      ...u32le(crc),
      ...u32le(data.length),
      ...u32le(data.length),
      ...u16le(name.length),
      ...u16le(0),          // extra field length
      ...name,
      ...data,
    ]);
    localHeaders.push({ local, name, crc, size: data.length, offset });
    offset += local.length;
  }

  for (const { name: nameBytes, crc, size, offset: lhOffset } of localHeaders.map((h, i) => ({
    name: enc.encode(files[i].name), crc: h.crc, size: h.size, offset: h.offset,
  }))) {
    centralHeaders.push(new Uint8Array([
      0x50,0x4b,0x01,0x02, // central dir sig
      ...u16le(20),         // version made by
      ...u16le(20),         // version needed
      ...u16le(0),          // flags
      ...u16le(0),          // compression
      ...u16le(0),          // mod time
      ...u16le(0),          // mod date
      ...u32le(crc),
      ...u32le(size),
      ...u32le(size),
      ...u16le(nameBytes.length),
      ...u16le(0),          // extra
      ...u16le(0),          // comment
      ...u16le(0),          // disk start
      ...u16le(0),          // int attr
      ...u32le(0),          // ext attr
      ...u32le(lhOffset),
      ...nameBytes,
    ]));
  }

  const cdSize = centralHeaders.reduce((s, h) => s + h.length, 0);
  const eocd = new Uint8Array([
    0x50,0x4b,0x05,0x06, // end of central dir sig
    ...u16le(0), ...u16le(0),
    ...u16le(centralHeaders.length),
    ...u16le(centralHeaders.length),
    ...u32le(cdSize),
    ...u32le(offset),
    ...u16le(0),
  ]);

  const parts = [...localHeaders.map(h => h.local), ...centralHeaders, eocd];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

// ── Fetch all repo files recursively via GitHub tree API ──────────────────

async function fetchRepoFiles(token, repo) {
  const branchRes = await fetch(`${GH_API}/repos/${repo}`, { headers: ghHeaders(token) });
  if (!branchRes.ok) throw new Error('Cannot access repo');
  const { default_branch } = await branchRes.json();

  const treeRes = await fetch(
    `${GH_API}/repos/${repo}/git/trees/${default_branch}?recursive=1`,
    { headers: ghHeaders(token) }
  );
  if (!treeRes.ok) throw new Error('Cannot fetch repo tree');
  const { tree } = await treeRes.json();

  const files = [];
  for (const item of tree) {
    if (item.type !== 'blob') continue;
    // Only export content files (posts + images), skip theme/config
    if (!item.path.startsWith('content/')) continue;
    const blobRes = await fetch(`${GH_API}/repos/${repo}/git/blobs/${item.sha}`, {
      headers: { ...ghHeaders(token), Accept: 'application/vnd.github.raw+json' },
    });
    if (!blobRes.ok) continue;
    const data = new Uint8Array(await blobRes.arrayBuffer());
    files.push({ name: item.path, data });
  }
  return files;
}

// ── Public export functions ───────────────────────────────────────────────

export async function exportContent(env, site) {
  const token = env.GITHUB_ORG_TOKEN;
  const files = await fetchRepoFiles(token, site.github_repo);
  if (!files.length) throw new Error('No content files found');

  const zip = buildZip(files);
  const date = new Date().toISOString().slice(0, 10);
  return new Response(zip, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${site.id}-content-${date}.zip"`,
    },
  });
}

export async function exportHTML(env, site) {
  if (!site.pages_project || !env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    throw new Error('Pages project not configured for this site');
  }

  // Get latest deployment
  const deplRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${site.pages_project}/deployments?per_page=1`,
    { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } }
  );
  if (!deplRes.ok) throw new Error('Cannot fetch Pages deployments');
  const { result: [deployment] } = await deplRes.json();
  if (!deployment) throw new Error('No deployments found yet');

  // Fetch build artifact zip
  const artifactRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${site.pages_project}/deployments/${deployment.id}/history/logs`,
    { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } }
  );

  // Cloudflare Pages doesn't expose a direct build artifact download via API yet.
  // Best available: redirect to the deployment URL with a note.
  const date = new Date().toISOString().slice(0, 10);
  const deploymentUrl = deployment.url;

  return Response.json({
    message: 'Your site is available at the URL below. Use a tool like wget or HTTrack to download all pages as HTML files.',
    deploymentUrl,
    tip: `wget --mirror --convert-links --no-parent ${deploymentUrl}`,
    customDomain: site.custom_domain ? `https://${site.custom_domain}` : null,
  });
}

export async function transferRepo(env, site, targetOwner) {
  const token = env.GITHUB_ORG_TOKEN;
  const res = await fetch(`${GH_API}/repos/${site.github_repo}/transfer`, {
    method: 'POST',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ new_owner: targetOwner }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub transfer failed: ${err}`);
  }
  return res.json();
}
