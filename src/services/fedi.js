const INSTANCE_URL = () => (process.env.FEDI_INSTANCE_URL || '').replace(/\/$/, '');
const TOKEN = () => process.env.FEDI_ACCESS_TOKEN;

async function uploadImage(imageBuffer, mimeType, alt = '') {
  const formData = new FormData();
  formData.append('file', new Blob([imageBuffer], { type: mimeType }), `upload.${mimeType.split('/')[1]}`);
  if (alt) formData.append('description', alt);

  const res = await fetch(`${INSTANCE_URL()}/api/v2/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN()}` },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Fedi media upload failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.id;
}

async function createPost({ text, images = [], replyTo = null, visibility = 'public', contentWarning = '' }) {
  const mediaIds = [];
  for (const img of images) {
    const id = await uploadImage(img.buffer, img.mimeType, img.alt);
    mediaIds.push(id);
  }

  const body = {
    status: text,
    visibility,
    media_ids: mediaIds,
  };

  if (contentWarning) body.spoiler_text = contentWarning;
  if (replyTo) body.in_reply_to_id = replyTo;

  const res = await fetch(`${INSTANCE_URL()}/api/v1/statuses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const respBody = await res.text();
    throw new Error(`Fedi post failed (${res.status}): ${respBody}`);
  }

  const data = await res.json();
  return { id: data.id };
}

module.exports = { createPost };
