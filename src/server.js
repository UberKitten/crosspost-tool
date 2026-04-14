require('dotenv').config({ override: true });

const express = require('express');
const path = require('path');
const postsRouter = require('./routes/posts');
const draftsRouter = require('./routes/drafts');
const scheduler = require('./services/scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for X-Forwarded-* headers
app.set('trust proxy', true);

app.use(express.json({ limit: '10mb' }));

// API routes
app.use('/api/posts', postsRouter);
app.use('/api/drafts', draftsRouter);

// Config endpoint (non-sensitive)
app.get('/api/config', (req, res) => {
  res.json({
    fediCharLimit: Number(process.env.FEDI_CHAR_LIMIT) || 3000,
    blueskyCharLimit: 300,
  });
});

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// SPA fallback
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Startup validation
const warnings = [];
if (!process.env.BLUESKY_HANDLE || !process.env.BLUESKY_APP_PASSWORD) warnings.push('Bluesky credentials not set — Bluesky posting will fail');
if (!process.env.FEDI_INSTANCE_URL || !process.env.FEDI_ACCESS_TOKEN) warnings.push('Fedi credentials not set — Fedi posting will fail');
if (!process.env.ANTHROPIC_API_KEY) warnings.push('ANTHROPIC_API_KEY not set — AI alt text will try Claude CLI fallback');

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Crosspost running on port ${PORT}`);
  warnings.forEach(w => console.warn(`  ⚠ ${w}`));
  scheduler.start();
});
