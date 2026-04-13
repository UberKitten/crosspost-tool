const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { executePost, getImageDir } = require('../services/poster');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

// Upload images — store originals with metadata stripped
router.post('/images', (req, res, next) => {
  upload.array('images', 4)(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `File too large (max 150MB)`
        : err.message || 'Upload failed';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, async (req, res) => {
  const results = [];
  for (const file of req.files) {
    const id = uuidv4();
    let mimeType = file.mimetype;
    let ext = path.extname(file.originalname) || '.jpg';
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);

    // Convert unsupported formats to jpeg
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
      mimeType = 'image/jpeg';
      ext = '.jpg';
    }

    try {
      // Strip all metadata (EXIF, GPS, ICC profiles, etc.) but keep image data intact
      const buffer = await sharp(file.buffer)
        .rotate() // auto-rotate based on EXIF orientation before stripping
        .withMetadata({ orientation: undefined }) // strip metadata
        .toBuffer();

      const filename = `${id}${ext}`;
      fs.writeFileSync(path.join(getImageDir(), filename), buffer);
      results.push({ id, filename, mimeType, size: buffer.length });
    } catch (err) {
      console.error(`Image processing failed (${sizeMB}MB ${mimeType}):`, err.message);
      return res.status(400).json({ error: `Failed to process image (${sizeMB}MB): ${err.message}` });
    }
  }
  res.json(results);
});

// Generate alt text for an image
router.post('/images/:filename/alt', async (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(getImageDir(), filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Image not found' });

  try {
    const { execSync } = require('child_process');
    const prompt = `Use the Read tool to read the image at ${filePath} and write alt text for it. This is for a social media post on Bluesky/Mastodon. The alt text should help non-sighted users understand what's in the image. If there is text, captions, labels, or dialogue in the image, transcribe it. Describe what's depicted factually and neutrally — no opinions, commentary, or editorializing. Just describe what's there. Keep it concise. Output ONLY the alt text, nothing else.`;
    const result = execSync(
      `claude -p ${JSON.stringify(prompt)} --model sonnet --allowedTools "Read" --max-turns 2`,
      { timeout: 60000, encoding: 'utf-8' }
    );
    res.json({ alt: result.trim() });
  } catch (err) {
    console.error('Alt text generation failed:', err.message);
    res.status(500).json({ error: 'Alt text generation failed' });
  }
});

// Create a post
router.post('/', async (req, res) => {
  const { text, targets, images = [], parentId, visibility, contentWarning, scheduledAt, blueskyLabels, blueskyThreadgate } = req.body;

  if (!text || !targets) return res.status(400).json({ error: 'text and targets are required' });
  if (!['bluesky', 'fedi', 'both'].includes(targets)) return res.status(400).json({ error: 'targets must be bluesky, fedi, or both' });

  const db = getDb();
  const postId = uuidv4();

  db.prepare(`
    INSERT INTO posts (id, text, targets, parent_id, visibility, content_warning, scheduled_at, bluesky_labels, bluesky_threadgate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(postId, text, targets, parentId || null, visibility || 'public', contentWarning || null, scheduledAt || null,
    blueskyLabels?.length ? JSON.stringify(blueskyLabels) : null,
    blueskyThreadgate || 'everyone');

  // Link images to post
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    db.prepare(`
      INSERT INTO images (id, post_id, filename, alt_text, mime_type, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(img.id, postId, img.filename, img.alt || '', img.mimeType, i);
  }

  // If not scheduled, post immediately
  if (!scheduledAt) {
    const result = await executePost(postId);
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
    const postImages = db.prepare('SELECT * FROM images WHERE post_id = ? ORDER BY sort_order').all(postId);
    return res.json({ post: { ...post, images: postImages }, result });
  }

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  const postImages = db.prepare('SELECT * FROM images WHERE post_id = ? ORDER BY sort_order').all(postId);
  res.json({ post: { ...post, images: postImages }, scheduled: true });
});

// List posts
router.get('/', (req, res) => {
  const db = getDb();
  const { filter, limit = 50, offset = 0 } = req.query;

  let where = 'WHERE posted_at IS NOT NULL OR scheduled_at IS NOT NULL';
  if (filter === 'bluesky') where += " AND targets = 'bluesky'";
  else if (filter === 'fedi') where += " AND targets = 'fedi'";
  else if (filter === 'both') where += " AND targets = 'both'";

  const posts = db.prepare(`
    SELECT * FROM posts ${where}
    ORDER BY COALESCE(posted_at, scheduled_at) DESC
    LIMIT ? OFFSET ?
  `).all(Number(limit), Number(offset));

  const postIds = posts.map(p => p.id);
  let images = [];
  if (postIds.length > 0) {
    const placeholders = postIds.map(() => '?').join(',');
    images = db.prepare(`SELECT * FROM images WHERE post_id IN (${placeholders}) ORDER BY sort_order`).all(...postIds);
  }

  const imagesByPost = {};
  for (const img of images) {
    if (!imagesByPost[img.post_id]) imagesByPost[img.post_id] = [];
    imagesByPost[img.post_id].push(img);
  }

  const result = posts.map(p => ({ ...p, images: imagesByPost[p.id] || [] }));
  res.json(result);
});

// Serve uploaded images
router.get('/images/:filename', (req, res) => {
  const filePath = path.join(getImageDir(), req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Image not found' });
  res.sendFile(filePath);
});

// Get single post with thread
router.get('/:id', (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const images = db.prepare('SELECT * FROM images WHERE post_id = ? ORDER BY sort_order').all(post.id);

  // Build thread (ancestors + descendants)
  const ancestors = [];
  let current = post;
  while (current.parent_id) {
    current = db.prepare('SELECT * FROM posts WHERE id = ?').get(current.parent_id);
    if (!current) break;
    const imgs = db.prepare('SELECT * FROM images WHERE post_id = ? ORDER BY sort_order').all(current.id);
    ancestors.unshift({ ...current, images: imgs });
  }

  const descendants = [];
  function getChildren(parentId) {
    const children = db.prepare('SELECT * FROM posts WHERE parent_id = ? ORDER BY created_at').all(parentId);
    for (const child of children) {
      const imgs = db.prepare('SELECT * FROM images WHERE post_id = ? ORDER BY sort_order').all(child.id);
      descendants.push({ ...child, images: imgs });
      getChildren(child.id);
    }
  }
  getChildren(post.id);

  res.json({ post: { ...post, images }, ancestors, descendants });
});

// Retry a failed post (for one platform)
router.post('/:id/retry', async (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const result = await executePost(post.id);
  const updated = db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
  const images = db.prepare('SELECT * FROM images WHERE post_id = ? ORDER BY sort_order').all(post.id);
  res.json({ post: { ...updated, images }, result });
});

// Delete a post (local only — does not delete from platforms)
router.delete('/:id', (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  // Delete associated image files
  const images = db.prepare('SELECT * FROM images WHERE post_id = ?').all(post.id);
  for (const img of images) {
    const filePath = path.join(getImageDir(), img.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  db.prepare('DELETE FROM images WHERE post_id = ?').run(post.id);
  db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
  res.json({ deleted: true });
});

// Update a scheduled post
router.put('/:id', (req, res) => {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.posted_at) return res.status(400).json({ error: 'Cannot edit a posted post' });

  const { text, targets, visibility, contentWarning, scheduledAt, images } = req.body;

  db.prepare(`
    UPDATE posts SET
      text = COALESCE(?, text),
      targets = COALESCE(?, targets),
      visibility = COALESCE(?, visibility),
      content_warning = ?,
      scheduled_at = ?
    WHERE id = ?
  `).run(text, targets, visibility, contentWarning ?? post.content_warning, scheduledAt ?? post.scheduled_at, post.id);

  // Update image alt texts if provided
  if (images) {
    for (const img of images) {
      if (img.id && img.alt !== undefined) {
        db.prepare('UPDATE images SET alt_text = ? WHERE id = ?').run(img.alt, img.id);
      }
    }
  }

  const updated = db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
  const postImages = db.prepare('SELECT * FROM images WHERE post_id = ? ORDER BY sort_order').all(post.id);
  res.json({ post: { ...updated, images: postImages } });
});

module.exports = router;
