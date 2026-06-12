const { BskyAgent, AtpAgent, RichText } = require('@atproto/api');
const sharp = require('sharp');

const VIDEO_SERVICE = 'https://video.bsky.app';

let agent = null;

async function getAgent() {
  if (agent) return agent;
  // PDS URL — defaults to bsky.social, override for self-hosted PDS.
  // The PDS handles auth + writes, and proxies app.bsky.* reads to its
  // configured appview (default api.bsky.app), so this is the only knob
  // needed when the appview stays default.
  const service = process.env.BLUESKY_PDS_URL || 'https://bsky.social';
  agent = new BskyAgent({ service });
  await agent.login({
    identifier: process.env.BLUESKY_HANDLE,
    password: process.env.BLUESKY_APP_PASSWORD,
  });
  return agent;
}

async function uploadImage(imageBuffer, mimeType) {
  const bsky = await getAgent();
  const response = await bsky.uploadBlob(imageBuffer, { encoding: mimeType });
  return response.data.blob;
}

// Upload a video through Bluesky's dedicated video service. Unlike images,
// this is an async job: request a service-auth token scoped to uploadBlob,
// POST the raw mp4 directly to video.bsky.app (NOT the PDS — it can't proxy
// uploadVideo), then poll getJobStatus until the processed blob is returned.
// See https://docs.bsky.app/docs/tutorials/video
async function uploadVideo(videoBuffer) {
  const bsky = await getAgent();

  const { data: serviceAuth } = await bsky.com.atproto.server.getServiceAuth({
    aud: `did:web:${bsky.dispatchUrl.host}`,
    lxm: 'com.atproto.repo.uploadBlob',
    exp: Math.floor(Date.now() / 1000) + 60 * 30, // 30 minutes
  });
  const token = serviceAuth.token;

  const uploadUrl = new URL(`${VIDEO_SERVICE}/xrpc/app.bsky.video.uploadVideo`);
  uploadUrl.searchParams.set('did', bsky.session.did);
  uploadUrl.searchParams.set('name', `${Date.now()}.mp4`);

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'video/mp4',
      'Content-Length': String(videoBuffer.length),
    },
    body: videoBuffer,
  });

  let job;
  try {
    job = await res.json();
  } catch {
    throw new Error(`Video upload failed (${res.status})`);
  }

  // If this exact video was already processed, the service returns an
  // already_exists error carrying the existing blob — usable as-is.
  let blob = job?.jobStatus?.blob || job?.blob;
  if (!res.ok && !blob) {
    const msg = job?.message || job?.error || `status ${res.status}`;
    throw new Error(`Video upload failed: ${msg}`);
  }

  const jobId = job?.jobStatus?.jobId || job?.jobId;
  if (!blob && !jobId) throw new Error('Video upload returned no job id');

  // Poll the video service for completion (separate agent, no PDS proxy).
  const videoAgent = new AtpAgent({ service: VIDEO_SERVICE });
  const deadline = Date.now() + 5 * 60 * 1000; // 5 min cap
  while (!blob) {
    if (Date.now() > deadline) throw new Error('Video processing timed out');
    await new Promise(r => setTimeout(r, 2000));
    let status;
    try {
      ({ data: status } = await videoAgent.app.bsky.video.getJobStatus({ jobId }));
    } catch (err) {
      // already_exists surfaces here too, with the blob attached.
      const js = err?.error === 'already_exists' ? err : null;
      if (js?.blob) { blob = js.blob; break; }
      throw err;
    }
    const js = status.jobStatus;
    if (js.blob) { blob = js.blob; break; }
    if (js.state === 'JOB_STATE_FAILED') {
      throw new Error(`Video processing failed: ${js.error || js.message || 'unknown'}`);
    }
  }

  return blob;
}

async function createPost({ text, images = [], video = null, replyTo = null, labels = [], threadgate = 'everyone' }) {
  const bsky = await getAgent();

  const rt = new RichText({ text });
  await rt.detectFacets(bsky);

  const record = {
    $type: 'app.bsky.feed.post',
    text: rt.text,
    facets: rt.facets,
    createdAt: new Date().toISOString(),
  };

  // Self-labels (content warnings like sexual, nudity, porn, graphic-media)
  if (labels.length > 0) {
    record.labels = {
      $type: 'com.atproto.label.defs#selfLabels',
      values: labels.map(val => ({ val })),
    };
  }

  if (video) {
    const blob = await uploadVideo(video.buffer);
    const embed = { $type: 'app.bsky.embed.video', video: blob };
    if (video.alt) embed.alt = video.alt;
    if (video.width && video.height) {
      embed.aspectRatio = { width: video.width, height: video.height };
    }
    record.embed = embed;
  } else if (images.length > 0) {
    const embeds = [];
    for (const img of images) {
      const blob = await uploadImage(img.buffer, img.mimeType);
      const meta = await sharp(img.buffer).metadata();
      const embed = { alt: img.alt || '', image: blob };
      if (meta.width && meta.height) {
        embed.aspectRatio = { width: meta.width, height: meta.height };
      }
      embeds.push(embed);
    }
    record.embed = {
      $type: 'app.bsky.embed.images',
      images: embeds,
    };
  }

  // Link card embed (only when no images — Bluesky doesn't support both)
  if (images.length === 0 && !record.embed) {
    const urls = text.match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/g);
    if (urls && urls.length > 0) {
      try {
        const card = await fetchLinkCard(bsky, urls[0]);
        if (card) record.embed = card;
      } catch (err) {
        console.error('Link card fetch failed:', err.message);
      }
    }
  }

  if (replyTo) {
    record.reply = {
      root: { uri: replyTo.rootUri || replyTo.uri, cid: replyTo.rootCid || replyTo.cid },
      parent: { uri: replyTo.uri, cid: replyTo.cid },
    };
  }

  const response = await bsky.post(record);

  // Create threadgate if not "everyone"
  if (threadgate !== 'everyone') {
    const allow = buildThreadgateRules(threadgate);
    await bsky.api.com.atproto.repo.createRecord({
      repo: bsky.session.did,
      collection: 'app.bsky.feed.threadgate',
      rkey: response.uri.split('/').pop(),
      record: {
        $type: 'app.bsky.feed.threadgate',
        post: response.uri,
        allow,
        createdAt: new Date().toISOString(),
      },
    });
  }

  return { uri: response.uri, cid: response.cid };
}

async function fetchLinkCard(bsky, url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Crosspost/1.0 (link preview)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;

  const html = await res.text();

  // Parse OG tags
  const og = {};
  const metaRegex = /<meta\s+(?:property|name)=["'](og:[^"']+)["']\s+content=["']([^"']*)["']/gi;
  let match;
  while ((match = metaRegex.exec(html)) !== null) {
    og[match[1]] = match[2];
  }
  // Also try reversed attribute order
  const metaRegex2 = /<meta\s+content=["']([^"']*)["']\s+(?:property|name)=["'](og:[^"']+)["']/gi;
  while ((match = metaRegex2.exec(html)) !== null) {
    og[match[2]] = match[1];
  }

  const title = og['og:title'] || html.match(/<title>([^<]*)<\/title>/i)?.[1] || url;
  const description = og['og:description'] || '';
  const thumbUrl = og['og:image'];

  const card = {
    $type: 'app.bsky.embed.external',
    external: {
      uri: url,
      title: decodeHTMLEntities(title).slice(0, 300),
      description: decodeHTMLEntities(description).slice(0, 1000),
    },
  };

  // Upload thumbnail if available
  if (thumbUrl) {
    try {
      const absUrl = thumbUrl.startsWith('http') ? thumbUrl : new URL(thumbUrl, url).href;
      const imgRes = await fetch(absUrl, {
        headers: { 'User-Agent': 'Crosspost/1.0 (link preview)' },
        signal: AbortSignal.timeout(10000),
      });
      if (imgRes.ok) {
        const imgBuf = Buffer.from(await imgRes.arrayBuffer());
        // Resize to fit Bluesky limits
        let processed = await sharp(imgBuf)
          .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        if (processed.length <= 1000000) {
          const blob = await uploadImage(processed, 'image/jpeg');
          card.external.thumb = blob;
        }
      }
    } catch {}
  }

  return card;
}

function decodeHTMLEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}

function buildThreadgateRules(threadgate) {
  switch (threadgate) {
    case 'nobody':
      return [];
    case 'mentioned':
      return [{ $type: 'app.bsky.feed.threadgate#mentionRule' }];
    case 'followers':
      return [{ $type: 'app.bsky.feed.threadgate#followerRule' }];
    case 'following':
      return [{ $type: 'app.bsky.feed.threadgate#followingRule' }];
    default:
      return undefined; // everyone
  }
}

function resetAgent() {
  agent = null;
}

module.exports = { createPost, resetAgent };
