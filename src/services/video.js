const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

// Bluesky accepts mp4 only, up to 100MB. Mastodon-compatible servers accept a
// range of formats but mp4 is the safe common denominator, so we normalize
// everything to mp4 and let both platforms share one file.
const VIDEO_MIME = 'video/mp4';
const VIDEO_EXT = '.mp4';

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = '';
    proc.stdout.on('data', d => { stdout = Buffer.concat([stdout, d]); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => reject(new Error(`${cmd} not available: ${err.message}`)));
    proc.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim().slice(-500)}`));
    });
  });
}

// Probe width/height of a video file via ffprobe.
async function probeDimensions(filePath) {
  const out = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'json',
    filePath,
  ]);
  try {
    const json = JSON.parse(out.toString());
    const s = json.streams?.[0];
    if (s?.width && s?.height) return { width: s.width, height: s.height };
  } catch {}
  return { width: null, height: null };
}

// Transcode an arbitrary video buffer to mp4 (H.264/AAC, faststart for web
// playback). Returns the mp4 buffer. Used for non-mp4 input like iOS .mov.
async function transcodeToMp4(inputBuffer, inputExt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xpost-vid-'));
  const inPath = path.join(dir, `in${inputExt || '.bin'}`);
  const outPath = path.join(dir, `out${VIDEO_EXT}`);
  try {
    fs.writeFileSync(inPath, inputBuffer);
    await run('ffmpeg', [
      '-i', inPath,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-y', outPath,
    ]);
    return fs.readFileSync(outPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Probe dimensions of an in-memory mp4 buffer (writes to a temp file first,
// since ffprobe needs a seekable input).
async function probeBufferDimensions(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xpost-probe-'));
  const p = path.join(dir, `v${VIDEO_EXT}`);
  try {
    fs.writeFileSync(p, buffer);
    return await probeDimensions(p);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Normalize an uploaded video to an mp4 buffer + dimensions. Transcodes when
// the source isn't already mp4.
async function normalizeVideo(buffer, mimeType, originalExt) {
  let mp4;
  if (mimeType === VIDEO_MIME) {
    mp4 = buffer;
  } else {
    mp4 = await transcodeToMp4(buffer, originalExt);
  }
  const { width, height } = await probeBufferDimensions(mp4);
  return { buffer: mp4, mimeType: VIDEO_MIME, width, height };
}

module.exports = { normalizeVideo, transcodeToMp4, probeDimensions, VIDEO_MIME, VIDEO_EXT };
