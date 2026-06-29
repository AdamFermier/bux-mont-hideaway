CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  github_repo TEXT NOT NULL,
  github_token TEXT NOT NULL,
  github_branch TEXT NOT NULL DEFAULT 'main',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE site_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  UNIQUE(site_id, email)
);

CREATE TABLE otp_codes (
  email TEXT NOT NULL,
  site_id TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (email, site_id)
);
