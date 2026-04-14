const { BskyAgent, RichText } = require('@atproto/api');
const sharp = require('sharp');

let agent = null;

async function getAgent() {
  if (agent) return agent;
  agent = new BskyAgent({ service: 'https://bsky.social' });
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

async function createPost({ text, images = [], replyTo = null, labels = [], threadgate = 'everyone' }) {
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

  if (images.length > 0) {
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
