const REPO = 'AdamFermier/bux-mont-hideaway';
const BRANCH = 'main';
const API = 'https://api.github.com';

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'bux-mont-hideaway-cms/1.0',
    'Content-Type': 'application/json',
  };
}

async function ghFetch(token, path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { ...ghHeaders(token), ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function buildFrontmatter(title, date, description, type, authorName) {
  const category = type === 'event' ? 'Events' : 'Updates';
  return [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `date: ${date}`,
    'draft: false',
    `description: "${description.replace(/"/g, '\\"')}"`,
    `categories: ["${category}"]`,
    `author: "${authorName}"`,
    '---',
  ].join('\n');
}

function buildMarkdown({ title, description, body, type, authorName, hasPhotos }) {
  const now = new Date();
  const offset = '-04:00'; // Eastern
  const date = now.toISOString().replace('Z', offset);
  const frontmatter = buildFrontmatter(title, date, description, type, authorName);
  const carouselBlock = (type === 'event' && hasPhotos) ? '\n\n{{< carousel >}}' : '';
  return `${frontmatter}\n\n${body}${carouselBlock}\n`;
}

async function createBlob(token, content, encoding = 'utf-8') {
  const data = await ghFetch(token, `/repos/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content, encoding }),
  });
  return data.sha;
}

export async function publishPost(env, { type, title, description, body, authorName, photos }) {
  const token = env.GITHUB_TOKEN;

  // 1. Get current HEAD commit
  const ref = await ghFetch(token, `/repos/${REPO}/git/ref/heads/${BRANCH}`);
  const headSha = ref.object.sha;

  // 2. Get base tree SHA
  const headCommit = await ghFetch(token, `/repos/${REPO}/git/commits/${headSha}`);
  const baseTreeSha = headCommit.tree.sha;

  // 3. Build the page bundle path
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const slug = slugify(title) || `post-${Date.now()}`;
  const dir = `content/en/blog/${dateStr}-${slug}`;

  // 4. Create blobs for all files
  const treeItems = [];

  // index.md
  const hasPhotos = photos && photos.length > 0;
  const markdown = buildMarkdown({ title, description, body, type, authorName, hasPhotos });
  const mdSha = await createBlob(token, markdown, 'utf-8');
  treeItems.push({ path: `${dir}/index.md`, mode: '100644', type: 'blob', sha: mdSha });

  // Photos (base64-encoded)
  if (hasPhotos) {
    for (let i = 0; i < photos.length; i++) {
      const { data: b64, ext } = photos[i];
      const filename = `carousel-${String(i + 1).padStart(2, '0')}.${ext}`;
      const blobSha = await createBlob(token, b64, 'base64');
      treeItems.push({ path: `${dir}/${filename}`, mode: '100644', type: 'blob', sha: blobSha });
    }
  }

  // 5. Create new tree
  const newTree = await ghFetch(token, `/repos/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
  });

  // 6. Create commit
  const commitMessage = `Add blog post: ${title}`;
  const newCommit = await ghFetch(token, `/repos/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: commitMessage,
      tree: newTree.sha,
      parents: [headSha],
    }),
  });

  // 7. Advance branch ref
  await ghFetch(token, `/repos/${REPO}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha }),
  });

  return { slug: `${dateStr}-${slug}`, dir };
}
