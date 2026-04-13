const { getDb } = require('../db');
const bluesky = require('./bluesky');
const fedi = require('./fedi');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const UPLOAD_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '../../data'), 'uploads');

function getImageDir() {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  return UPLOAD_DIR;
}

async function loadImages(postId) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM images WHERE post_id = ? ORDER BY sort_order').all(postId);
  return rows.map(row => {
    const filePath = path.join(getImageDir(), row.filename);
    return {
      buffer: fs.readFileSync(filePath),
      mimeType: row.mime_type,
      alt: row.alt_text,
    };
  });
}

// Prepare image for Bluesky: max 2000px any dimension, max 1MB
async function compressForBluesky(img) {
  const BSKY_MAX_DIM = 2000;
  const BSKY_MAX_SIZE = 1000000;

  let buffer = img.buffer;
  let mimeType = img.mimeType;

  // Resize if any dimension exceeds 2000px
  const meta = await sharp(buffer).metadata();
  if (meta.width > BSKY_MAX_DIM || meta.height > BSKY_MAX_DIM) {
    buffer = await sharp(buffer).resize(BSKY_MAX_DIM, BSKY_MAX_DIM, { fit: 'inside', withoutEnlargement: true }).toBuffer();
  }

  if (buffer.length <= BSKY_MAX_SIZE) return { ...img, buffer, mimeType };

  // Progressive jpeg compression to get under 1MB
  let quality = 85;
  while (buffer.length > BSKY_MAX_SIZE && quality > 20) {
    buffer = await sharp(img.buffer)
      .resize(BSKY_MAX_DIM, BSKY_MAX_DIM, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
    mimeType = 'image/jpeg';
    quality -= 10;
  }

  return { ...img, buffer, mimeType };
}

// Prepare image for Fedi: respect instance limit (default 10MB)
async function compressForFedi(img) {
  const FEDI_MAX_SIZE = 10 * 1024 * 1024; // 10MB

  let buffer = img.buffer;
  let mimeType = img.mimeType;

  if (buffer.length <= FEDI_MAX_SIZE) return img;

  // Resize large dimensions first (no point sending 8000px to fedi)
  const meta = await sharp(buffer).metadata();
  if (meta.width > 4096 || meta.height > 4096) {
    buffer = await sharp(buffer).resize(4096, 4096, { fit: 'inside', withoutEnlargement: true }).toBuffer();
  }

  if (buffer.length <= FEDI_MAX_SIZE) return { ...img, buffer, mimeType };

  // Progressive jpeg compression
  let quality = 90;
  while (buffer.length > FEDI_MAX_SIZE && quality > 30) {
    buffer = await sharp(img.buffer)
      .resize(4096, 4096, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
    mimeType = 'image/jpeg';
    quality -= 10;
  }

  return { ...img, buffer, mimeType };
}

function findThreadRoot(db, postId) {
  let current = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  while (current && current.parent_id) {
    current = db.prepare('SELECT * FROM posts WHERE id = ?').get(current.parent_id);
  }
  return current;
}

async function executePost(postId) {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) throw new Error('Post not found');

  const images = await loadImages(postId);
  const targets = post.targets;

  let blueskyResult = null;
  let fediResult = null;
  let blueskyError = null;
  let fediError = null;

  // Post to Bluesky (compress images to 1MB limit)
  if (targets === 'bluesky' || targets === 'both') {
    try {
      let replyTo = null;
      if (post.parent_id) {
        const parent = db.prepare('SELECT * FROM posts WHERE id = ?').get(post.parent_id);
        if (parent && parent.bluesky_uri) {
          const root = findThreadRoot(db, post.parent_id);
          replyTo = {
            uri: parent.bluesky_uri,
            cid: parent.bluesky_cid,
            rootUri: root?.bluesky_uri || parent.bluesky_uri,
            rootCid: root?.bluesky_cid || parent.bluesky_cid,
          };
        }
      }
      const bskyImages = await Promise.all(images.map(compressForBluesky));
      const labels = post.bluesky_labels ? JSON.parse(post.bluesky_labels) : [];
      blueskyResult = await bluesky.createPost({
        text: post.text, images: bskyImages, replyTo,
        labels,
        threadgate: post.bluesky_threadgate || 'everyone',
      });
    } catch (err) {
      blueskyError = err.message;
      console.error('Bluesky post failed:', err.message);
    }
  }

  // Post to Fedi (compress to instance limit)
  if (targets === 'fedi' || targets === 'both') {
    try {
      let replyTo = null;
      if (post.parent_id) {
        const parent = db.prepare('SELECT * FROM posts WHERE id = ?').get(post.parent_id);
        if (parent && parent.fedi_id) replyTo = parent.fedi_id;
      }
      const fediImages = await Promise.all(images.map(compressForFedi));
      fediResult = await fedi.createPost({
        text: post.text,
        images: fediImages,
        replyTo,
        visibility: post.visibility || 'public',
        contentWarning: post.content_warning || '',
      });
    } catch (err) {
      fediError = err.message;
      console.error('Fedi post failed:', err.message);
    }
  }

  // Update DB
  db.prepare(`
    UPDATE posts SET
      bluesky_uri = ?, bluesky_cid = ?,
      fedi_id = ?,
      bluesky_error = ?, fedi_error = ?,
      posted_at = datetime('now')
    WHERE id = ?
  `).run(
    blueskyResult?.uri || post.bluesky_uri,
    blueskyResult?.cid || post.bluesky_cid,
    fediResult?.id || post.fedi_id,
    blueskyError, fediError,
    postId
  );

  return {
    bluesky: blueskyResult ? { success: true, ...blueskyResult } : (blueskyError ? { success: false, error: blueskyError } : null),
    fedi: fediResult ? { success: true, ...fediResult } : (fediError ? { success: false, error: fediError } : null),
  };
}

module.exports = { executePost, getImageDir };
