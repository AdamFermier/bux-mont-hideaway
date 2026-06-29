-- Make github_token nullable (now using GITHUB_ORG_TOKEN env secret instead of per-site tokens)
-- SQLite requires recreating the table to remove NOT NULL constraint.
PRAGMA foreign_keys=OFF;

CREATE TABLE sites_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  github_repo TEXT NOT NULL,
  github_token TEXT,
  github_branch TEXT NOT NULL DEFAULT 'main',
  created_at TEXT DEFAULT (datetime('now')),
  repo_seq INTEGER,
  visibility TEXT NOT NULL DEFAULT 'public',
  custom_domain TEXT,
  pages_project TEXT,
  transfer_requested_at TEXT
);

INSERT INTO sites_new SELECT
  id, name, github_repo, github_token, github_branch, created_at,
  repo_seq, visibility, custom_domain, pages_project, transfer_requested_at
FROM sites;

DROP TABLE sites;
ALTER TABLE sites_new RENAME TO sites;

PRAGMA foreign_keys=ON;
