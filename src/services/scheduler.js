const { getDb } = require('../db');
const { executePost } = require('./poster');

let intervalId = null;

function start(intervalMs = 15000) {
  if (intervalId) return;

  console.log(`Scheduler started (checking every ${intervalMs / 1000}s)`);

  intervalId = setInterval(async () => {
    const db = getDb();
    const due = db.prepare(`
      SELECT * FROM posts
      WHERE scheduled_at IS NOT NULL
        AND posted_at IS NULL
        AND scheduled_at <= datetime('now')
    `).all();

    for (const post of due) {
      console.log(`Executing scheduled post ${post.id}`);
      try {
        await executePost(post.id);
      } catch (err) {
        console.error(`Failed to execute scheduled post ${post.id}:`, err.message);
      }
    }
  }, intervalMs);
}

function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

module.exports = { start, stop };
