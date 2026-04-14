const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');

const router = express.Router();

const EMPTY_THREAD = '[{"text":"","images":[]}]';

function threadHasContent(threadJson) {
  try {
    const entries = JSON.parse(threadJson || EMPTY_THREAD);
    return entries.some(e => (e.text || '').trim() || (e.images && e.images.length > 0));
  } catch { return false; }
}

// Get active draft
router.get('/active', (req, res) => {
  const db = getDb();
  const draft = db.prepare('SELECT * FROM drafts WHERE is_active = 1 LIMIT 1').get();
  res.json(draft || null);
});

// Upsert active draft (auto-save)
router.put('/active', (req, res) => {
  const db = getDb();
  const { thread, targets, parentId } = req.body;

  let draft = db.prepare('SELECT * FROM drafts WHERE is_active = 1 LIMIT 1').get();

  const threadJson = thread !== undefined ? JSON.stringify(thread) : undefined;

  if (draft) {
    db.prepare(`
      UPDATE drafts SET thread = ?, targets = ?, parent_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      threadJson ?? draft.thread,
      targets ?? draft.targets,
      parentId !== undefined ? parentId : draft.parent_id,
      draft.id
    );
    draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draft.id);
  } else {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO drafts (id, thread, targets, parent_id, is_active)
      VALUES (?, ?, ?, ?, 1)
    `).run(id, threadJson || EMPTY_THREAD, targets || 'both', parentId || null);
    draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
  }

  res.json(draft);
});

// Stash current draft
router.post('/stash', (req, res) => {
  const db = getDb();
  const active = db.prepare('SELECT * FROM drafts WHERE is_active = 1 LIMIT 1').get();
  if (!active || !threadHasContent(active.thread)) {
    return res.json({ stashed: false, message: 'Nothing to stash' });
  }
  db.prepare("UPDATE drafts SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(active.id);
  res.json({ stashed: true, id: active.id });
});

// Clear active draft
router.delete('/active', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM drafts WHERE is_active = 1').run();
  res.json({ cleared: true });
});

// List stashed drafts (prune empty ones)
router.get('/', (req, res) => {
  const db = getDb();
  const all = db.prepare('SELECT * FROM drafts WHERE is_active = 0 ORDER BY updated_at DESC').all();
  const empty = all.filter(d => !threadHasContent(d.thread));
  for (const d of empty) db.prepare('DELETE FROM drafts WHERE id = ?').run(d.id);
  const drafts = all.filter(d => threadHasContent(d.thread));
  res.json(drafts);
});

// Restore a stashed draft
router.post('/:id/restore', (req, res) => {
  const db = getDb();
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });

  const active = db.prepare('SELECT * FROM drafts WHERE is_active = 1').all();
  for (const a of active) {
    if (threadHasContent(a.thread)) {
      db.prepare('UPDATE drafts SET is_active = 0 WHERE id = ?').run(a.id);
    } else {
      db.prepare('DELETE FROM drafts WHERE id = ?').run(a.id);
    }
  }
  db.prepare("UPDATE drafts SET is_active = 1, updated_at = datetime('now') WHERE id = ?").run(draft.id);

  const restored = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draft.id);
  res.json(restored);
});

// Delete a stashed draft
router.delete('/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM drafts WHERE id = ?').run(req.params.id);
  res.json({ deleted: true });
});

module.exports = router;
