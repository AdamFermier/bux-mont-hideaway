const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getSite(db, siteId) {
  const row = await db.prepare('SELECT * FROM sites WHERE id = ?').bind(siteId).first();
  return row || null;
}

export async function getUserForSite(db, siteId, email) {
  const row = await db
    .prepare('SELECT * FROM site_users WHERE site_id = ? AND lower(email) = lower(?)')
    .bind(siteId, email)
    .first();
  return row || null;
}

export async function saveOTP(db, siteId, email, code) {
  const expiresAt = Date.now() + OTP_TTL_MS;
  await db
    .prepare(
      `INSERT INTO otp_codes (email, site_id, code, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(email, site_id) DO UPDATE SET code=excluded.code, expires_at=excluded.expires_at`
    )
    .bind(email.toLowerCase(), siteId, code, expiresAt)
    .run();
}

export async function verifyOTP(db, siteId, email, code) {
  const row = await db
    .prepare('SELECT * FROM otp_codes WHERE email = lower(?) AND site_id = ?')
    .bind(email, siteId)
    .first();
  if (!row) return false;
  if (Date.now() > row.expires_at) {
    await db
      .prepare('DELETE FROM otp_codes WHERE email = lower(?) AND site_id = ?')
      .bind(email, siteId)
      .run();
    return false;
  }
  if (row.code !== code) return false;
  await db
    .prepare('DELETE FROM otp_codes WHERE email = lower(?) AND site_id = ?')
    .bind(email, siteId)
    .run();
  return true;
}

// Admin queries
export async function listSites(db) {
  const { results } = await db
    .prepare(`
      SELECT s.*, COUNT(u.id) as user_count
      FROM sites s
      LEFT JOIN site_users u ON u.site_id = s.id
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `)
    .all();
  return results;
}

export async function createSite(db, { id, name, github_repo, github_token, github_branch = 'main' }) {
  await db
    .prepare('INSERT INTO sites (id, name, github_repo, github_token, github_branch) VALUES (?, ?, ?, ?, ?)')
    .bind(id, name, github_repo, github_token, github_branch)
    .run();
}

export async function listUsersForSite(db, siteId) {
  const { results } = await db
    .prepare('SELECT * FROM site_users WHERE site_id = ? ORDER BY id')
    .bind(siteId)
    .all();
  return results;
}

export async function addUserToSite(db, siteId, email, displayName) {
  await db
    .prepare('INSERT OR IGNORE INTO site_users (site_id, email, display_name) VALUES (?, lower(?), ?)')
    .bind(siteId, email, displayName || null)
    .run();
}

export async function removeUserFromSite(db, siteId, userId) {
  await db
    .prepare('DELETE FROM site_users WHERE id = ? AND site_id = ?')
    .bind(userId, siteId)
    .run();
}
