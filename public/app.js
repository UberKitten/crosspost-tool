(() => {
  'use strict';

  let config = { fediCharLimit: 3000, blueskyCharLimit: 300 };
  let replyTo = null;
  let uploadedImages = []; // [{ id, filename, mimeType, alt }]
  let timelineFilter = 'all';
  let showSchedule = false;
  let target = 'both';
  let showDraftsList = false;
  let stashedDrafts = [];

  // Platform settings
  let fediVisibility = 'public';
  let fediCW = '';
  let bskyLabels = [];
  let bskyThreadgate = 'everyone';

  // Collapsible state
  let bskySettingsOpen = false;
  let fediSettingsOpen = false;

  // Drag reorder state
  let dragIdx = null;

  // Autosave
  let autosaveTimer = null;
  let lastSavedText = '';

  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => [...(el || document).querySelectorAll(sel)];
  const main = () => $('#main');

  function getCharLimit() {
    if (target === 'bluesky') return config.blueskyCharLimit;
    if (target === 'fedi') return config.fediCharLimit;
    return Math.min(config.blueskyCharLimit, config.fediCharLimit);
  }
  function isBsky() { return target === 'bluesky' || target === 'both'; }
  function isFedi() { return target === 'fedi' || target === 'both'; }
  function bskyHasNonDefaults() { return bskyLabels.length > 0 || bskyThreadgate !== 'everyone'; }
  function fediHasNonDefaults() { return fediVisibility !== 'public' || fediCW.length > 0; }

  // ── Init ──
  async function init() {
    const [cfgRes, draftRes] = await Promise.all([
      fetch('/api/config'),
      fetch('/api/drafts/active'),
    ]);
    config = await cfgRes.json();
    const draft = await draftRes.json();
    if (draft) {
      target = draft.targets || 'both';
      lastSavedText = draft.text || '';
      const imgs = draft.images ? JSON.parse(draft.images) : [];
      uploadedImages = imgs;
      if (draft.parent_id) {
        replyTo = { id: draft.parent_id, text: '(saved draft reply)', targets: target };
      }
    }
    render();
    setupGlobalDrop();
  }

  // ── Global drag & drop ──
  function setupGlobalDrop() {
    let dragCounter = 0;
    const overlay = document.createElement('div');
    overlay.className = 'drop-overlay';
    overlay.innerHTML = '<div class="drop-overlay-label">Drop images to attach</div>';
    document.body.appendChild(overlay);

    document.addEventListener('dragenter', e => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      dragCounter++;
      overlay.classList.add('visible');
    });
    document.addEventListener('dragleave', () => {
      dragCounter--;
      if (dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('visible'); }
    });
    document.addEventListener('dragover', e => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
    });
    document.addEventListener('drop', e => {
      dragCounter = 0;
      overlay.classList.remove('visible');
      const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); uploadFiles(files); }
    });
  }

  // ── Full page ──
  function render() {
    main().innerHTML = renderComposer() +
      '<div class="section-divider">Timeline</div>' +
      '<div id="timeline-area"><div class="loading">Loading...</div></div>';
    bindComposerEvents();
    loadTimeline();
  }

  // ── Composer HTML ──
  function renderComposer() {
    const limit = getCharLimit();
    const text = lastSavedText;
    return `
      <div class="composer">
        ${replyTo ? `
          <div class="reply-context">
            <span class="reply-text">Replying to: ${esc(replyTo.text.slice(0, 80))}${replyTo.text.length > 80 ? '...' : ''}</span>
            <button class="cancel-reply">&times;</button>
          </div>
        ` : ''}
        <div class="target-selector">
          <button class="target-btn ${target === 'bluesky' ? 'active-bluesky' : ''}" data-target="bluesky">Bluesky</button>
          <button class="target-btn ${target === 'both' ? 'active-both' : ''}" data-target="both">Both</button>
          <button class="target-btn ${target === 'fedi' ? 'active-fedi' : ''}" data-target="fedi">Fedi</button>
        </div>
        <div class="compose-area">
          <textarea id="compose-text" placeholder="What's on your mind?">${esc(text)}</textarea>
          <span class="char-count" id="char-count">0 / ${limit}</span>
        </div>
        <div class="image-upload-area">
          <div class="image-grid" id="image-grid"></div>
          ${uploadedImages.length < 4 ? `
            <label class="add-image-btn">
              <input type="file" accept="image/*" multiple hidden id="image-input" />
              + Add images (or paste / drop)
            </label>
          ` : ''}
        </div>
        <div class="platform-settings">
          ${renderBlueskySettings()}
          ${renderFediSettings()}
        </div>
        <div class="drafts-bar">
          <button class="stash-btn" id="stash-btn">Stash draft</button>
          <span class="draft-count" id="draft-count"></span>
          <span class="autosave-indicator" id="autosave-ind">saved</span>
        </div>
        ${showDraftsList ? renderDraftsList() : ''}
        <div class="post-actions">
          <button class="post-btn primary" id="post-btn" disabled>Post now</button>
          <button class="post-btn secondary" id="schedule-toggle">${showSchedule ? 'Cancel' : 'Schedule'}</button>
        </div>
        ${showSchedule ? '<div class="schedule-picker"><input type="datetime-local" id="schedule-time" /></div>' : ''}
      </div>
    `;
  }

  function renderBlueskySettings() {
    const disabled = !isBsky();
    const hasNonDefaults = bskyHasNonDefaults();
    const open = bskySettingsOpen || hasNonDefaults;
    const labels = ['sexual', 'nudity', 'porn', 'graphic-media'];
    return `
      <div class="platform-group ${disabled ? 'disabled' : ''}">
        <div class="platform-group-header" data-toggle="bsky">
          <span class="dot dot-bluesky"></span> Bluesky
          ${hasNonDefaults ? '<span class="setting-alert">!</span>' : ''}
          <span class="chevron ${open ? 'open' : ''}">&#9654;</span>
        </div>
        <div class="platform-group-body ${open ? '' : 'collapsed'}" id="bsky-body">
          <div class="setting-row">
            <label>Replies</label>
            <select id="bsky-threadgate">
              ${['everyone','mentioned','followers','following','nobody'].map(v =>
                `<option value="${v}" ${bskyThreadgate === v ? 'selected' : ''}>${v === 'following' ? 'People I follow' : v.charAt(0).toUpperCase() + v.slice(1)}</option>`
              ).join('')}
            </select>
          </div>
          <div class="setting-row">
            <label>Labels</label>
            <div class="label-chips">
              ${labels.map(l => `<button class="label-chip ${bskyLabels.includes(l) ? 'active' : ''}" data-label="${l}">${l}</button>`).join('')}
            </div>
          </div>
        </div>
      </div>`;
  }

  function renderFediSettings() {
    const disabled = !isFedi();
    const hasNonDefaults = fediHasNonDefaults();
    const open = fediSettingsOpen || hasNonDefaults;
    return `
      <div class="platform-group ${disabled ? 'disabled' : ''}">
        <div class="platform-group-header" data-toggle="fedi">
          <span class="dot dot-fedi"></span> Fedi
          ${hasNonDefaults ? '<span class="setting-alert">!</span>' : ''}
          <span class="chevron ${open ? 'open' : ''}">&#9654;</span>
        </div>
        <div class="platform-group-body ${open ? '' : 'collapsed'}" id="fedi-body">
          <div class="setting-row">
            <label>Visibility</label>
            <select id="fedi-visibility">
              ${['public','unlisted','private','direct'].map(v =>
                `<option value="${v}" ${fediVisibility === v ? 'selected' : ''}>${{public:'Public',unlisted:'Unlisted',private:'Followers only',direct:'Direct'}[v]}</option>`
              ).join('')}
            </select>
          </div>
          <div class="setting-row">
            <label>CW</label>
            <input type="text" id="fedi-cw" placeholder="Content warning (optional)" value="${escAttr(fediCW)}" />
          </div>
        </div>
      </div>`;
  }

  function renderDraftsList() {
    if (!stashedDrafts.length) return '<div class="drafts-list"><div class="draft-item"><span class="draft-text">No stashed drafts</span></div></div>';
    return `<div class="drafts-list">${stashedDrafts.map(d => {
      const imgs = d.images ? JSON.parse(d.images) : [];
      return `
        <div class="draft-item">
          ${imgs.length ? `<div class="draft-thumbs">${imgs.map(i =>
            `<img class="draft-thumb" src="/api/posts/images/${i.filename}" data-draft-img="/api/posts/images/${i.filename}" />`
          ).join('')}</div>` : ''}
          <span class="draft-text">${esc(d.text ? d.text.slice(0, 60) : (imgs.length ? `(${imgs.length} image${imgs.length > 1 ? 's' : ''})` : '(empty)'))}</span>
          <button data-draft-restore="${d.id}">Restore</button>
          <button data-draft-delete="${d.id}">Delete</button>
        </div>`;
    }).join('')}</div>`;
  }

  // ── Image grid ──
  function renderImageGrid() {
    const grid = $('#image-grid');
    if (!grid) return;
    grid.innerHTML = uploadedImages.map((img, i) => `
      <div class="image-preview ${dragIdx === i ? 'dragging' : ''}" draggable="true" data-idx="${i}">
        <img src="/api/posts/images/${img.filename}" alt="" data-view-idx="${i}" />
        <div class="img-actions">
          ${i > 0 ? `<button class="img-action-btn" data-move="${i}" data-dir="-1">&larr;</button>` : ''}
          ${i < uploadedImages.length - 1 ? `<button class="img-action-btn" data-move="${i}" data-dir="1">&rarr;</button>` : ''}
          <button class="img-action-btn" data-remove="${i}">&times;</button>
        </div>
        <div class="alt-row">
          <textarea class="alt-input" data-alt-idx="${i}" placeholder="Alt text..." rows="1">${esc(img.alt || '')}</textarea>
          <button class="auto-alt-btn" data-auto-alt="${i}">AI</button>
        </div>
      </div>
    `).join('');
  }

  // ── Composer state save/restore for rerender ──
  function saveState() {
    return {
      text: $('#compose-text')?.value ?? lastSavedText,
      schedTime: $('#schedule-time')?.value || '',
      selStart: $('#compose-text')?.selectionStart,
      selEnd: $('#compose-text')?.selectionEnd,
    };
  }

  function restoreState(s) {
    const ta = $('#compose-text');
    if (ta) {
      ta.value = s.text;
      if (s.selStart != null) ta.setSelectionRange(s.selStart, s.selEnd);
    }
    if ($('#schedule-time') && s.schedTime) $('#schedule-time').value = s.schedTime;
    updateCharCount();
  }

  function rerenderComposer() {
    const s = saveState();
    lastSavedText = s.text; // keep in sync so renderComposer uses current text
    syncSettingsFromDOM();
    const el = $('.composer');
    if (el) {
      el.outerHTML = renderComposer();
      renderImageGrid();
      bindComposerEvents();
      restoreState(s);
    }
  }

  // Clean render from current state — no save/restore cycle
  // Use after stash/restore where state vars are already set
  function freshRenderComposer() {
    const el = $('.composer');
    if (el) {
      el.outerHTML = renderComposer();
      renderImageGrid();
      bindComposerEvents();
      updateCharCount();
    }
  }

  function syncSettingsFromDOM() {
    const v = $('#fedi-visibility'); if (v) fediVisibility = v.value;
    const c = $('#fedi-cw'); if (c) fediCW = c.value;
    const t = $('#bsky-threadgate'); if (t) bskyThreadgate = t.value;
  }

  // ── Event binding ──
  function bindComposerEvents() {
    renderImageGrid();

    // Targets
    $$('.target-btn').forEach(b => b.addEventListener('click', () => { target = b.dataset.target; triggerAutosave(); rerenderComposer(); }));

    // Textarea
    const ta = $('#compose-text');
    if (ta) {
      ta.addEventListener('input', () => { updateCharCount(); triggerAutosave(); });
      // Paste images
      ta.addEventListener('paste', handlePaste);
      // Drag & drop on textarea
      ta.addEventListener('dragover', e => { e.preventDefault(); ta.classList.add('drag-over'); });
      ta.addEventListener('dragleave', () => ta.classList.remove('drag-over'));
      ta.addEventListener('drop', e => { ta.classList.remove('drag-over'); handleDrop(e); });
      ta.focus();
    }

    // Cancel reply
    const cr = $('.cancel-reply');
    if (cr) cr.addEventListener('click', () => { replyTo = null; triggerAutosave(); rerenderComposer(); });

    // File input
    const fi = $('#image-input');
    if (fi) fi.addEventListener('change', e => uploadFiles(Array.from(e.target.files)));

    // Image grid events
    const grid = $('#image-grid');
    if (grid) {
      grid.addEventListener('click', e => {
        // View image
        const viewImg = e.target.closest('[data-view-idx]');
        if (viewImg) { openLightbox(Number(viewImg.dataset.viewIdx)); return; }
        // Remove
        const rm = e.target.closest('[data-remove]');
        if (rm) { uploadedImages.splice(Number(rm.dataset.remove), 1); triggerAutosave(); rerenderComposer(); return; }
        // Move
        const mv = e.target.closest('[data-move]');
        if (mv) {
          const i = Number(mv.dataset.move), d = Number(mv.dataset.dir);
          [uploadedImages[i], uploadedImages[i + d]] = [uploadedImages[i + d], uploadedImages[i]];
          triggerAutosave(); renderImageGrid(); return;
        }
        // Auto alt (toggle generate/cancel)
        const aa = e.target.closest('[data-auto-alt]');
        if (aa) { generateAlt(Number(aa.dataset.autoAlt)); return; }
      });
      grid.addEventListener('input', e => {
        const ai = e.target.closest('[data-alt-idx]');
        if (ai) { uploadedImages[Number(ai.dataset.altIdx)].alt = ai.value; triggerAutosave(); }
      });
      // Drag reorder
      grid.addEventListener('dragstart', e => {
        const card = e.target.closest('.image-preview');
        if (card) { dragIdx = Number(card.dataset.idx); card.classList.add('dragging'); }
      });
      grid.addEventListener('dragover', e => {
        e.preventDefault();
        const card = e.target.closest('.image-preview');
        $$('.image-preview', grid).forEach(c => c.classList.remove('drag-target'));
        if (card) card.classList.add('drag-target');
      });
      grid.addEventListener('drop', e => {
        const card = e.target.closest('.image-preview');
        if (card && dragIdx !== null) {
          const to = Number(card.dataset.idx);
          if (dragIdx !== to) {
            const [item] = uploadedImages.splice(dragIdx, 1);
            uploadedImages.splice(to, 0, item);
            triggerAutosave();
          }
        }
        dragIdx = null;
        renderImageGrid();
      });
      grid.addEventListener('dragend', () => { dragIdx = null; renderImageGrid(); });
    }

    // Collapsible toggles
    $$('[data-toggle]').forEach(h => h.addEventListener('click', () => {
      if (h.dataset.toggle === 'bsky') bskySettingsOpen = !bskySettingsOpen;
      else fediSettingsOpen = !fediSettingsOpen;
      syncSettingsFromDOM();
      rerenderComposer();
    }));

    // Label chips
    $$('.label-chip').forEach(c => c.addEventListener('click', () => {
      const l = c.dataset.label;
      bskyLabels = bskyLabels.includes(l) ? bskyLabels.filter(x => x !== l) : [...bskyLabels, l];
      syncSettingsFromDOM(); rerenderComposer();
    }));

    // Settings changes
    const bskyTg = $('#bsky-threadgate');
    if (bskyTg) bskyTg.addEventListener('change', () => { bskyThreadgate = bskyTg.value; rerenderComposer(); });
    const fediVis = $('#fedi-visibility');
    if (fediVis) fediVis.addEventListener('change', () => { fediVisibility = fediVis.value; rerenderComposer(); });
    const fediCwIn = $('#fedi-cw');
    if (fediCwIn) fediCwIn.addEventListener('input', () => { fediCW = fediCwIn.value; });

    // Schedule
    const st = $('#schedule-toggle');
    if (st) st.addEventListener('click', () => { showSchedule = !showSchedule; rerenderComposer(); });
    if (showSchedule) { const pb = $('#post-btn'); if (pb) pb.textContent = 'Schedule'; }

    // Post
    const pb = $('#post-btn');
    if (pb) pb.addEventListener('click', handlePost);

    // Stash
    const sb = $('#stash-btn');
    if (sb) sb.addEventListener('click', handleStash);

    // Draft count
    loadDraftCount();
    const dc = $('#draft-count');
    if (dc) dc.addEventListener('click', toggleDraftsList);

    // Draft list buttons
    $$('[data-draft-restore]').forEach(b => b.addEventListener('click', () => restoreDraft(b.dataset.draftRestore)));
    $$('[data-draft-delete]').forEach(b => b.addEventListener('click', () => deleteDraft(b.dataset.draftDelete)));
    $$('[data-draft-img]').forEach(img => img.addEventListener('click', e => {
      e.stopPropagation();
      openStaticLightbox(img.dataset.draftImg);
    }));
  }

  // ── Image handling ──
  function handlePaste(e) {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter(i => i.type.startsWith('image/'));
    if (!imageItems.length) return;
    e.preventDefault();
    const files = imageItems.map(i => i.getAsFile()).filter(Boolean);
    uploadFiles(files);
  }

  function handleDrop(e) {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
    if (files.length) uploadFiles(files);
  }

  let uploading = false;
  let uploadProgress = 0;

  async function uploadFiles(files) {
    const slots = 4 - uploadedImages.length;
    if (slots <= 0) { toast('Max 4 images', 'error'); return; }
    if (uploading) { toast('Upload in progress', 'error'); return; }
    files = files.slice(0, slots);
    const totalMB = files.reduce((s, f) => s + f.size, 0) / 1024 / 1024;

    const formData = new FormData();
    for (const f of files) formData.append('images', f);

    uploading = true;
    uploadProgress = 0;
    showUploadProgress();

    try {
      const data = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/posts/images');
        xhr.upload.addEventListener('progress', e => {
          if (e.lengthComputable) {
            uploadProgress = e.loaded / e.total;
            showUploadProgress();
          }
        });
        xhr.addEventListener('load', () => {
          try {
            const json = JSON.parse(xhr.responseText);
            if (xhr.status >= 400) reject(new Error(json.error || 'Upload failed'));
            else resolve(json);
          } catch { reject(new Error('Upload failed')); }
        });
        xhr.addEventListener('error', () => reject(new Error('Upload failed')));
        xhr.send(formData);
      });

      for (const img of data) uploadedImages.push({ ...img, alt: '' });
      triggerAutosave();
      toast(`Uploaded ${files.length} image${files.length > 1 ? 's' : ''} (${totalMB.toFixed(1)}MB)`, 'success');
    } catch (err) {
      toast(err.message || 'Image upload failed', 'error');
    } finally {
      uploading = false;
      rerenderComposer();
    }
  }

  function showUploadProgress() {
    let bar = $('#upload-progress');
    if (!bar) {
      const area = $('.image-upload-area');
      if (!area) return;
      bar = document.createElement('div');
      bar.id = 'upload-progress';
      bar.className = 'upload-progress';
      bar.innerHTML = '<div class="upload-progress-bar"></div><span class="upload-progress-text"></span>';
      area.prepend(bar);
    }
    const pct = Math.round(uploadProgress * 100);
    bar.querySelector('.upload-progress-bar').style.width = pct + '%';
    bar.querySelector('.upload-progress-text').textContent =
      pct < 100 ? `Uploading... ${pct}%` : 'Processing...';
  }

  // Track per-image generation state: { [idx]: AbortController }
  const altGenerating = {};

  function isGeneratingAlt(idx) { return !!altGenerating[idx]; }

  async function generateAlt(idx) {
    // If already generating, cancel it
    if (altGenerating[idx]) {
      altGenerating[idx].abort();
      delete altGenerating[idx];
      updateAltUI();
      return;
    }

    const controller = new AbortController();
    altGenerating[idx] = controller;
    updateAltUI();

    try {
      const res = await fetch(`/api/posts/images/${uploadedImages[idx].filename}/alt`, {
        method: 'POST',
        signal: controller.signal,
      });
      const data = await res.json();
      if (data.alt) {
        uploadedImages[idx].alt = data.alt;
        // Update lightbox if open
        const lbInput = document.querySelector('.lightbox-alt-input');
        if (lbInput && document.querySelector('.lightbox')?.dataset.idx == idx) {
          lbInput.value = data.alt;
          lbInput.style.height = 'auto'; lbInput.style.height = lbInput.scrollHeight + 'px';
        }
        triggerAutosave();
      } else {
        toast('Alt text generation failed', 'error');
      }
    } catch (err) {
      if (err.name !== 'AbortError') toast('Alt text generation failed', 'error');
    } finally {
      delete altGenerating[idx];
      updateAltUI();
      renderImageGrid();
    }
  }

  // Update all visible alt-related UI to reflect generation state
  function updateAltUI() {
    // Grid buttons
    $$('[data-auto-alt]').forEach(btn => {
      const i = Number(btn.dataset.autoAlt);
      const gen = isGeneratingAlt(i);
      btn.textContent = gen ? 'Stop' : 'AI';
      btn.classList.toggle('generating', gen);
    });
    // Grid alt inputs — readonly while generating
    $$('[data-alt-idx]').forEach(ta => {
      ta.classList.toggle('alt-busy', isGeneratingAlt(Number(ta.dataset.altIdx)));
    });
    // Lightbox button if open
    const lbBtn = document.querySelector('.lightbox-ai-btn');
    const lb = document.querySelector('.lightbox');
    if (lbBtn && lb) {
      const i = Number(lb.dataset.idx);
      const gen = isGeneratingAlt(i);
      lbBtn.textContent = gen ? 'Stop generating' : 'Generate alt text';
      lbBtn.classList.toggle('generating', gen);
      const lbInput = document.querySelector('.lightbox-alt-input');
      if (lbInput) lbInput.classList.toggle('alt-busy', gen);
    }
  }

  // ── Lightbox ──
  function openLightbox(idx) {
    const img = uploadedImages[idx];
    if (!img) return;
    const gen = isGeneratingAlt(idx);
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.dataset.idx = idx;
    lb.innerHTML = `
      <div class="lightbox-content">
        <img src="/api/posts/images/${img.filename}" />
        <div class="lightbox-alt">
          <textarea class="lightbox-alt-input ${gen ? 'alt-busy' : ''}" placeholder="Alt text...">${esc(img.alt || '')}</textarea>
          <button class="lightbox-ai-btn ${gen ? 'generating' : ''}">${gen ? 'Stop generating' : 'Generate alt text'}</button>
        </div>
      </div>
    `;
    lb.addEventListener('click', e => { if (e.target === lb) closeLightbox(lb, idx); });
    const onKey = e => { if (e.key === 'Escape') { closeLightbox(lb, idx); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    lb.querySelector('.lightbox-ai-btn').addEventListener('click', () => generateAlt(idx));
    const lbTa = lb.querySelector('.lightbox-alt-input');
    const autoGrow = () => { lbTa.style.height = 'auto'; lbTa.style.height = lbTa.scrollHeight + 'px'; };
    lbTa.addEventListener('input', e => { uploadedImages[idx].alt = e.target.value; autoGrow(); triggerAutosave(); });
    document.body.appendChild(lb);
    autoGrow(); // size on open
  }

  function closeLightbox(lb, idx) {
    const ta = lb.querySelector('.lightbox-alt-input');
    if (ta) { uploadedImages[idx].alt = ta.value; renderImageGrid(); }
    lb.remove();
  }

  function openStaticLightbox(src) {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `<img src="${src}" />`;
    lb.addEventListener('click', () => lb.remove());
    const onKey = e => { if (e.key === 'Escape') { lb.remove(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(lb);
  }


  // ── Char count ──
  function updateCharCount() {
    const ta = $('#compose-text'), cc = $('#char-count');
    if (!ta || !cc) return;
    const len = ta.value.length, limit = getCharLimit();
    cc.textContent = `${len} / ${limit}`;
    cc.classList.toggle('over', len > limit);
    const pb = $('#post-btn');
    if (pb) pb.disabled = len === 0 || len > limit;
  }

  // ── Autosave ──
  function triggerAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(doAutosave, 800);
  }

  async function doAutosave() {
    const text = $('#compose-text')?.value ?? '';
    const body = {
      text,
      targets: target,
      images: uploadedImages.map(i => ({ id: i.id, filename: i.filename, mimeType: i.mimeType, alt: i.alt })),
      parentId: replyTo?.id || null,
    };
    try {
      await fetch('/api/drafts/active', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      lastSavedText = text;
      flashAutosave();
    } catch { /* silent */ }
  }

  function flashAutosave() {
    const ind = $('#autosave-ind');
    if (!ind) return;
    ind.classList.add('visible');
    setTimeout(() => ind.classList.remove('visible'), 1500);
  }

  // ── Drafts ──
  async function loadDraftCount() {
    const res = await fetch('/api/drafts');
    stashedDrafts = await res.json();
    const dc = $('#draft-count');
    if (dc) dc.textContent = stashedDrafts.length ? `${stashedDrafts.length} stashed` : '';
  }

  async function handleStash() {
    const text = ($('#compose-text')?.value ?? '').trim();
    if (!text && !uploadedImages.length) { toast('Nothing to stash', 'error'); return; }
    // Save current state first
    syncSettingsFromDOM();
    await doAutosave();
    const res = await fetch('/api/drafts/stash', { method: 'POST' });
    const data = await res.json();
    if (data.stashed) {
      toast('Draft stashed', 'success');
      lastSavedText = '';
      uploadedImages = [];
      replyTo = null;
      showDraftsList = false;
      freshRenderComposer();
      loadDraftCount();
    }
  }

  function toggleDraftsList() {
    showDraftsList = !showDraftsList;
    syncSettingsFromDOM();
    rerenderComposer();
  }

  async function restoreDraft(id) {
    // Stash current if non-empty (don't lose work)
    const text = ($('#compose-text')?.value ?? '').trim();
    if (text.length > 0 || uploadedImages.length > 0) {
      syncSettingsFromDOM();
      await doAutosave();
      await fetch('/api/drafts/stash', { method: 'POST' });
    }

    const res = await fetch(`/api/drafts/${id}/restore`, { method: 'POST' });
    const draft = await res.json();
    target = draft.targets || 'both';
    lastSavedText = draft.text || '';
    uploadedImages = draft.images ? JSON.parse(draft.images) : [];
    replyTo = draft.parent_id ? { id: draft.parent_id, text: '(restored draft)', targets: target } : null;
    showDraftsList = false;
    freshRenderComposer();
    await loadDraftCount();
    toast('Draft restored', 'success');
  }

  async function deleteDraft(id) {
    await fetch(`/api/drafts/${id}`, { method: 'DELETE' });
    await loadDraftCount();
    syncSettingsFromDOM();
    rerenderComposer();
    toast('Draft deleted', 'success');
  }

  // ── Post ──
  async function handlePost() {
    const text = $('#compose-text')?.value?.trim();
    if (!text) return;
    const pb = $('#post-btn');
    pb.disabled = true;
    pb.textContent = showSchedule ? 'Scheduling...' : 'Posting...';

    syncSettingsFromDOM();
    const body = {
      text, targets: target,
      images: uploadedImages.map(i => ({ id: i.id, filename: i.filename, mimeType: i.mimeType, alt: i.alt })),
      visibility: fediVisibility,
      contentWarning: fediCW || '',
      parentId: replyTo?.id || null,
      scheduledAt: showSchedule ? ($('#schedule-time')?.value ? new Date($('#schedule-time').value).toISOString() : null) : null,
      blueskyLabels: bskyLabels.length ? bskyLabels : null,
      blueskyThreadgate: bskyThreadgate,
    };

    if (showSchedule && !body.scheduledAt) {
      toast('Pick a time', 'error');
      pb.disabled = false; pb.textContent = 'Schedule'; return;
    }

    try {
      const res = await fetch('/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error || 'Failed', 'error'); pb.disabled = false; pb.textContent = showSchedule ? 'Schedule' : 'Post now'; return; }

      if (data.result) {
        const b = data.result.bluesky, f = data.result.fedi;
        if (b && !b.success && f && f.success) toast('Posted to Fedi, Bluesky failed', 'error');
        else if (f && !f.success && b && b.success) toast('Posted to Bluesky, Fedi failed', 'error');
        else if (b && !b.success && f && !f.success) toast('Both failed', 'error');
        else toast('Posted!', 'success');
      } else toast('Scheduled!', 'success');

      // Clear draft
      await fetch('/api/drafts/active', { method: 'DELETE' });
      replyTo = null; uploadedImages = []; showSchedule = false;
      fediCW = ''; bskyLabels = []; bskyThreadgate = 'everyone'; fediVisibility = 'public';
      bskySettingsOpen = false; fediSettingsOpen = false;
      lastSavedText = '';
      rerenderComposer();
      loadTimeline();
    } catch {
      toast('Network error', 'error');
      pb.disabled = false; pb.textContent = showSchedule ? 'Schedule' : 'Post now';
    }
  }

  // ── Timeline ──
  async function loadTimeline() {
    const area = $('#timeline-area');
    if (!area) return;
    const fp = timelineFilter === 'all' ? '' : `?filter=${timelineFilter}`;
    const res = await fetch(`/api/posts${fp}`);
    const posts = await res.json();

    area.innerHTML = `
      <div class="filter-bar">
        ${['all','bluesky','fedi','both'].map(f =>
          `<button class="filter-btn ${timelineFilter === f ? 'active' : ''}" data-filter="${f}">${f === 'all' ? 'All' : f === 'both' ? 'Both' : f.charAt(0).toUpperCase() + f.slice(1)}</button>`
        ).join('')}
      </div>
      <div class="timeline" id="timeline-list">
        ${posts.length === 0 ? '<div class="empty-state"><div class="emoji">+</div><p>No posts yet</p></div>'
          : posts.map(renderPostCard).join('')}
      </div>`;
    bindTimelineEvents(posts);
  }

  function renderPostCard(p) {
    const sched = p.scheduled_at && !p.posted_at;
    const time = p.posted_at || p.scheduled_at;
    const errs = p.bluesky_error || p.fedi_error;
    return `
      <div class="post-card" data-id="${p.id}">
        <div class="post-meta">
          ${p.parent_id ? '<span class="thread-indicator">&gt; </span>' : ''}
          <span class="badge badge-${p.targets}">${p.targets}</span>
          ${sched ? '<span class="badge badge-scheduled">scheduled</span>' : ''}
          <span>${fmtTime(time)}</span>
        </div>
        ${p.content_warning ? `<div class="post-cw">CW: ${esc(p.content_warning)}</div>` : ''}
        <div class="post-text">${esc(p.text)}</div>
        ${p.images?.length ? `<div class="post-images">${p.images.map(i => `<img src="/api/posts/images/${i.filename}" alt="${escAttr(i.alt_text)}" />`).join('')}</div>` : ''}
        ${errs ? `<div class="post-errors">${p.bluesky_error ? `<div class="error-line">Bluesky: ${esc(p.bluesky_error)}</div>` : ''}${p.fedi_error ? `<div class="error-line">Fedi: ${esc(p.fedi_error)}</div>` : ''}</div>` : ''}
        <div class="post-footer">
          ${!sched ? `<button class="action-btn" data-post-id="${p.id}" data-action="reply">Reply</button>` : ''}
          ${errs ? `<button class="action-btn" data-post-id="${p.id}" data-action="retry">Retry</button>` : ''}
          <button class="action-btn delete-btn" data-post-id="${p.id}" data-action="delete" title="Delete from Crosspost">&times;</button>
        </div>
      </div>`;
  }

  function bindTimelineEvents(posts) {
    $$('.filter-btn').forEach(b => b.addEventListener('click', () => { timelineFilter = b.dataset.filter; loadTimeline(); }));
    $$('.post-card').forEach(c => c.addEventListener('click', e => { if (!e.target.closest('.action-btn')) renderThread(c.dataset.id); }));
    $$('.action-btn').forEach(b => b.addEventListener('click', async e => {
      e.stopPropagation();
      const id = b.dataset.postId, act = b.dataset.action;
      if (act === 'reply') {
        const p = posts.find(x => x.id === id);
        replyTo = { id, text: p.text, targets: p.targets };
        target = p.targets;
        triggerAutosave();
        rerenderComposer();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (act === 'retry') {
        b.disabled = true; b.textContent = 'Retrying...';
        await fetch(`/api/posts/${id}/retry`, { method: 'POST' });
        toast('Retried', 'success'); loadTimeline();
      } else if (act === 'delete') {
        if (confirm('Delete this post? (only removes from Crosspost, not from platforms)')) {
          await fetch(`/api/posts/${id}`, { method: 'DELETE' });
          toast('Deleted', 'success'); loadTimeline();
        }
      }
    }));
  }

  // ── Thread view ──
  async function renderThread(postId) {
    const area = $('#timeline-area');
    area.innerHTML = '<div class="loading">Loading...</div>';
    const res = await fetch(`/api/posts/${postId}`);
    const { post, ancestors, descendants } = await res.json();
    const all = [...ancestors, post, ...descendants];
    area.innerHTML = `<div class="thread-view">
      <button class="thread-back">&larr; Back</button>
      ${all.map(p => `<div class="thread-post ${p.id === post.id ? 'current' : ''}">${renderPostCard(p)}</div>`).join('')}
    </div>`;
    $('.thread-back').addEventListener('click', loadTimeline);
    $$('.post-card').forEach(c => c.addEventListener('click', e => { if (!e.target.closest('.action-btn')) renderThread(c.dataset.id); }));
    $$('.action-btn').forEach(b => b.addEventListener('click', async e => {
      e.stopPropagation();
      if (b.dataset.action === 'reply') {
        const p = all.find(x => x.id === b.dataset.postId);
        replyTo = { id: p.id, text: p.text, targets: p.targets };
        target = p.targets;
        triggerAutosave(); rerenderComposer();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (b.dataset.action === 'retry') {
        b.disabled = true; await fetch(`/api/posts/${b.dataset.postId}/retry`, { method: 'POST' });
        renderThread(postId);
      } else if (b.dataset.action === 'delete') {
        if (confirm('Delete this post? (only removes from Crosspost, not from platforms)')) {
          await fetch(`/api/posts/${b.dataset.postId}`, { method: 'DELETE' });
          toast('Deleted', 'success'); loadTimeline();
        }
      }
    }));
  }

  // ── Helpers ──
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function escAttr(s) { return (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso), ms = Date.now() - d;
    if (ms < 60000) return 'just now';
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function toast(msg, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  init();
})();
