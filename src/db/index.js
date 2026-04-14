const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, '../../data'), 'crosspost.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      targets TEXT NOT NULL,
      visibility TEXT DEFAULT 'public',
      content_warning TEXT,
      parent_id TEXT REFERENCES posts(id),
      bluesky_uri TEXT,
      bluesky_cid TEXT,
      fedi_id TEXT,
      bluesky_labels TEXT,
      bluesky_threadgate TEXT DEFAULT 'everyone',
      bluesky_error TEXT,
      fedi_error TEXT,
      scheduled_at TEXT,
      posted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      alt_text TEXT DEFAULT '',
      mime_type TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_id);
    CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts(scheduled_at) WHERE scheduled_at IS NOT NULL AND posted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
    CREATE INDEX IF NOT EXISTS idx_images_post ON images(post_id);

    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      thread TEXT NOT NULL DEFAULT '[{"text":"","images":[]}]',
      targets TEXT DEFAULT 'both',
      is_active INTEGER NOT NULL DEFAULT 0,
      parent_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_drafts_active ON drafts(is_active) WHERE is_active = 1;
    CREATE INDEX IF NOT EXISTS idx_drafts_updated ON drafts(updated_at);
  `);
}

module.exports = { getDb };
