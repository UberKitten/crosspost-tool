const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');

const router = express.Router();

// Get active draft (the one being composed)
router.get('/active', (req, res) => {
  const db = getDb();
  const draft = db.prepare('SELECT * FROM drafts WHERE is_active = 1 LIMIT 1').get();
  res.json(draft || null);
});

// Upsert active draft (auto-save)
router.put('/active', (req, res) => {
  const db = getDb();
  const { text, targets, images, parentId } = req.body;

  let draft = db.prepare('SELECT * FROM drafts WHERE is_active = 1 LIMIT 1').get();

  if (draft) {
    db.prepare(`
      UPDATE drafts SET text = ?, targets = ?, images = ?, parent_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      text ?? draft.text,
      targets ?? draft.targets,
      images !== undefined ? JSON.stringify(images) : draft.images,
      parentId !== undefined ? parentId : draft.parent_id,
      draft.id
    );
    draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draft.id);
  } else {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO drafts (id, text, targets, images, parent_id, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(id, text || '', targets || 'both', JSON.stringify(images || []), parentId || null);
    draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
  }

  res.json(draft);
});

// Stash current draft (deactivate it, keep it saved)
router.post('/stash', (req, res) => {
  const db = getDb();
  const active = db.prepare('SELECT * FROM drafts WHERE is_active = 1 LIMIT 1').get();
  if (!active || (!(active.text || '').trim() && (!active.images || active.images === '[]'))) {
    return res.json({ stashed: false, message: 'Nothing to stash' });
  }
  db.prepare('UPDATE drafts SET is_active = 0, updated_at = datetime(\'now\') WHERE id = ?').run(active.id);
  res.json({ stashed: true, id: active.id });
});

// Clear active draft (after successful post)
router.delete('/active', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM drafts WHERE is_active = 1').run();
  res.json({ cleared: true });
});

// List stashed drafts (prune empty ones)
router.get('/', (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM drafts WHERE is_active = 0 AND COALESCE(TRIM(text), '') = '' AND (images IS NULL OR images = '[]')").run();
  const drafts = db.prepare('SELECT * FROM drafts WHERE is_active = 0 ORDER BY updated_at DESC').all();
  res.json(drafts);
});

// Restore a stashed draft (make it active)
router.post('/:id/restore', (req, res) => {
  const db = getDb();
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });

  // Delete empty active drafts, stash non-empty ones
  const active = db.prepare('SELECT * FROM drafts WHERE is_active = 1').all();
  for (const a of active) {
    const hasContent = (a.text || '').trim() || (a.images && a.images !== '[]');
    if (hasContent) {
      db.prepare('UPDATE drafts SET is_active = 0 WHERE id = ?').run(a.id);
    } else {
      db.prepare('DELETE FROM drafts WHERE id = ?').run(a.id);
    }
  }
  // Restore this one
  db.prepare('UPDATE drafts SET is_active = 1, updated_at = datetime(\'now\') WHERE id = ?').run(draft.id);

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
