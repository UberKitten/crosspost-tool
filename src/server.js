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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Crosspost running on port ${PORT}`);
  scheduler.start();
});
