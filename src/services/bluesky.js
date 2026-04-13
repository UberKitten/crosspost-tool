const { BskyAgent, RichText } = require('@atproto/api');

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
      embeds.push({ alt: img.alt || '', image: blob });
    }
    record.embed = {
      $type: 'app.bsky.embed.images',
      images: embeds,
    };
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
