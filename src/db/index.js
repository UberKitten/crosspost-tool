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
      media_type TEXT NOT NULL DEFAULT 'image',
      width INTEGER,
      height INTEGER,
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

  migrateDraftsTextToThread(db);
  migrateImagesAddMedia(db);
}

// The `images` table predates video support. Add media_type/width/height
// columns to existing installs (CREATE TABLE IF NOT EXISTS won't touch them).
function migrateImagesAddMedia(db) {
  const cols = db.prepare("PRAGMA table_info(images)").all().map(c => c.name);
  if (!cols.includes('media_type')) {
    db.exec("ALTER TABLE images ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image'");
  }
  if (!cols.includes('width')) {
    db.exec('ALTER TABLE images ADD COLUMN width INTEGER');
  }
  if (!cols.includes('height')) {
    db.exec('ALTER TABLE images ADD COLUMN height INTEGER');
  }
}

// Pre-thread schema had `text TEXT` and `images TEXT` columns. CREATE TABLE
// IF NOT EXISTS skips the new schema for those installs, so detect and migrate.
function migrateDraftsTextToThread(db) {
  const cols = db.prepare("PRAGMA table_info(drafts)").all().map(c => c.name);
  if (cols.includes('thread')) return;
  if (!cols.includes('text')) return;

  const old = db.prepare('SELECT id, text, images, targets, is_active, parent_id, created_at, updated_at FROM drafts').all();
  db.exec('DROP TABLE drafts');
  db.exec(`
    CREATE TABLE drafts (
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

  const insert = db.prepare(`
    INSERT INTO drafts (id, thread, targets, is_active, parent_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of old) {
    let images = [];
    try { images = JSON.parse(r.images || '[]'); } catch {}
    const thread = JSON.stringify([{ text: r.text || '', images }]);
    insert.run(r.id, thread, r.targets, r.is_active, r.parent_id, r.created_at, r.updated_at);
  }
}

module.exports = { getDb };
