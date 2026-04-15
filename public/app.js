(() => {
  'use strict';

  let config = { fediCharLimit: 3000, blueskyCharLimit: 300 };
  let replyTo = null;
  let timelineFilter = 'all';
  let showSchedule = false;
  let target = 'both';
  let showDraftsList = false;
  let stashedDrafts = [];

  // Thread: array of { text, images: [{ id, filename, mimeType, alt }] }
  let thread = [{ text: '', images: [] }];

  // Platform settings (shared across thread)
  let fediVisibility = 'public';
  let fediCW = '';
  let bskyLabels = [];
  let bskyThreadgate = 'everyone';

  // Collapsible state
  let bskySettingsOpen = false;
  let fediSettingsOpen = false;

  // Upload/autosave
  let uploading = false;
  let uploadProgress = 0;
  let uploadTargetIdx = 0;
  let autosaveTimer = null;
  let dragIdx = null;

  // Alt generation: { 'entryIdx-imgIdx': AbortController }
  const altGenerating = {};

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
    const [cfgRes, draftRes] = await Promise.all([fetch('/api/config'), fetch('/api/drafts/active')]);
    config = await cfgRes.json();
    const draft = await draftRes.json();
    if (draft) {
      target = draft.targets || 'both';
      try { thread = JSON.parse(draft.thread); } catch { thread = [{ text: '', images: [] }]; }
      if (!thread.length) thread = [{ text: '', images: [] }];
      if (draft.parent_id) replyTo = { id: draft.parent_id, text: '(saved draft reply)', targets: target };
    }
    render();
    setupGlobalDrop();

    // Poll timeline every 30s
    setInterval(() => { if (document.visibilityState === 'visible') loadTimeline(); }, 30000);

    // Refresh timeline + draft count on tab focus
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { loadTimeline(); loadDraftCount(); }
    });
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
      dragCounter++; overlay.classList.add('visible');
    });
    document.addEventListener('dragleave', () => { dragCounter--; if (dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('visible'); } });
    document.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
    document.addEventListener('drop', e => {
      dragCounter = 0; overlay.classList.remove('visible');
      const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); uploadFiles(files, thread.length - 1); }
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

  // ── Composer ──
  function renderComposer() {
    const limit = getCharLimit();
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
        <div class="thread-entries" id="thread-entries">
          ${thread.map((entry, i) => renderThreadEntry(entry, i, limit)).join('')}
        </div>
        <button class="add-thread-btn" id="add-thread-btn">+ Add to thread</button>
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
          <button class="post-btn primary" id="post-btn" disabled>${thread.length > 1 ? 'Post thread' : 'Post now'}</button>
          <button class="post-btn secondary" id="schedule-toggle">${showSchedule ? 'Cancel' : 'Schedule'}</button>
        </div>
        ${showSchedule ? '<div class="schedule-picker"><input type="datetime-local" id="schedule-time" /></div>' : ''}
      </div>`;
  }

  function renderThreadEntry(entry, idx, limit) {
    const len = entry.text.length;
    const isOnly = thread.length === 1;
    return `
      <div class="thread-entry" data-entry="${idx}">
        ${!isOnly ? `<div class="thread-entry-header">
          <span class="thread-entry-num">${idx + 1}/${thread.length}</span>
          <button class="thread-entry-remove" data-remove-entry="${idx}">&times;</button>
        </div>` : ''}
        <div class="compose-area">
          <textarea class="compose-text" data-entry-text="${idx}" placeholder="${idx === 0 ? "What's on your mind?" : 'Continue thread...'}">${esc(entry.text)}</textarea>
          <span class="char-count ${len > limit ? 'over' : ''}">${len} / ${limit}</span>
        </div>
        <div class="image-upload-area" data-entry-images="${idx}">
          <div class="image-grid" data-img-grid="${idx}"></div>
          ${entry.images.length < 4 ? `
            <label class="add-image-btn">
              <input type="file" accept="image/*" multiple hidden data-file-input="${idx}" />
              + Add images
            </label>
          ` : ''}
        </div>
      </div>`;
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
                `<option value="${v}" ${bskyThreadgate === v ? 'selected' : ''}>${{everyone:'Everyone',mentioned:'Mentioned only',followers:'Followers',following:'People I follow',nobody:'Nobody'}[v]}</option>`
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
      let entries = [];
      try { entries = JSON.parse(d.thread); } catch {}
      const allImgs = entries.flatMap(e => e.images || []);
      const firstText = entries.find(e => (e.text || '').trim())?.text || '';
      const label = firstText ? firstText.slice(0, 60) : (allImgs.length ? `(${allImgs.length} image${allImgs.length > 1 ? 's' : ''})` : '(empty)');
      const countLabel = entries.length > 1 ? `<span class="badge badge-both">${entries.length} posts</span>` : '';
      return `
        <div class="draft-item">
          ${allImgs.length ? `<div class="draft-thumbs">${allImgs.slice(0, 4).map(i =>
            `<img class="draft-thumb" src="/api/posts/images/${i.filename}" data-draft-img="/api/posts/images/${i.filename}" />`
          ).join('')}</div>` : ''}
          <span class="draft-text">${countLabel} ${esc(label)}</span>
          <button data-draft-restore="${d.id}">Restore</button>
          <button data-draft-delete="${d.id}">Delete</button>
        </div>`;
    }).join('')}</div>`;
  }

  // ── Image grid per entry ──
  function renderAllImageGrids() {
    thread.forEach((entry, idx) => {
      const grid = $(`[data-img-grid="${idx}"]`);
      if (!grid) return;
      grid.innerHTML = entry.images.map((img, i) => `
        <div class="image-preview" draggable="true" data-entry="${idx}" data-idx="${i}">
          <img src="/api/posts/images/${img.filename}" alt="" data-view-entry="${idx}" data-view-idx="${i}" />
          <div class="img-actions">
            ${i > 0 ? `<button class="img-action-btn" data-move-entry="${idx}" data-move="${i}" data-dir="-1">&larr;</button>` : ''}
            ${i < entry.images.length - 1 ? `<button class="img-action-btn" data-move-entry="${idx}" data-move="${i}" data-dir="1">&rarr;</button>` : ''}
            <button class="img-action-btn" data-remove-img-entry="${idx}" data-remove="${i}">&times;</button>
          </div>
          <div class="alt-row">
            <textarea class="alt-input" data-alt-entry="${idx}" data-alt-idx="${i}" placeholder="Alt text..." rows="1">${esc(img.alt || '')}</textarea>
            <button class="auto-alt-btn ${isGeneratingAlt(idx, i) ? 'generating' : ''}" data-auto-alt-entry="${idx}" data-auto-alt="${i}">${isGeneratingAlt(idx, i) ? 'Stop' : 'AI'}</button>
          </div>
        </div>
      `).join('');
    });
  }

  // ── State management ──
  function syncThreadFromDOM() {
    $$('.compose-text').forEach(ta => {
      const idx = Number(ta.dataset.entryText);
      if (thread[idx]) thread[idx].text = ta.value;
    });
  }

  function syncSettingsFromDOM() {
    const v = $('#fedi-visibility'); if (v) fediVisibility = v.value;
    const c = $('#fedi-cw'); if (c) fediCW = c.value;
    const t = $('#bsky-threadgate'); if (t) bskyThreadgate = t.value;
  }

  function rerenderComposer() {
    syncThreadFromDOM();
    syncSettingsFromDOM();
    const el = $('.composer');
    if (el) {
      const schedTime = $('#schedule-time')?.value || '';
      el.outerHTML = renderComposer();
      renderAllImageGrids();
      bindComposerEvents();
      if ($('#schedule-time') && schedTime) $('#schedule-time').value = schedTime;
      updateAllCharCounts();
    }
  }

  function freshRenderComposer() {
    const el = $('.composer');
    if (el) {
      el.outerHTML = renderComposer();
      renderAllImageGrids();
      bindComposerEvents();
      updateAllCharCounts();
    }
  }

  function updateAllCharCounts() {
    const limit = getCharLimit();
    $$('.compose-text').forEach(ta => {
      const len = ta.value.length;
      const cc = ta.closest('.compose-area')?.querySelector('.char-count');
      if (cc) { cc.textContent = `${len} / ${limit}`; cc.classList.toggle('over', len > limit); }
    });
    updatePostBtn();
  }

  function updatePostBtn() {
    const pb = $('#post-btn');
    if (!pb) return;
    const limit = getCharLimit();
    const hasContent = thread.some(e => e.text.trim());
    const overLimit = thread.some(e => e.text.length > limit);
    pb.disabled = !hasContent || overLimit;
  }

  // ── Event binding ──
  function bindComposerEvents() {
    renderAllImageGrids();

    // Targets
    $$('.target-btn').forEach(b => b.addEventListener('click', () => { target = b.dataset.target; triggerAutosave(); rerenderComposer(); }));

    // Textareas
    $$('.compose-text').forEach(ta => {
      ta.addEventListener('input', () => {
        const idx = Number(ta.dataset.entryText);
        thread[idx].text = ta.value;
        autoGrowTextarea(ta);
        updateAllCharCounts();
        triggerAutosave();
      });
      autoGrowTextarea(ta); // size on bind (for restored drafts)
      ta.addEventListener('paste', e => handlePaste(e, Number(ta.dataset.entryText)));
      ta.addEventListener('dragover', e => { e.preventDefault(); ta.classList.add('drag-over'); });
      ta.addEventListener('dragleave', () => ta.classList.remove('drag-over'));
      ta.addEventListener('drop', e => { ta.classList.remove('drag-over'); handleDrop(e, Number(ta.dataset.entryText)); });
    });
    // Focus first empty or last
    const firstEmpty = $$('.compose-text').find(ta => !ta.value);
    (firstEmpty || $$('.compose-text').pop())?.focus();

    // Cancel reply
    const cr = $('.cancel-reply');
    if (cr) cr.addEventListener('click', () => { replyTo = null; triggerAutosave(); rerenderComposer(); });

    // File inputs
    $$('[data-file-input]').forEach(fi => fi.addEventListener('change', e => uploadFiles(Array.from(e.target.files), Number(fi.dataset.fileInput))));

    // Image grid events (delegated on each grid)
    $$('[data-img-grid]').forEach(grid => {
      const entryIdx = Number(grid.dataset.imgGrid);
      grid.addEventListener('click', e => {
        const viewImg = e.target.closest('[data-view-idx]');
        if (viewImg) { openLightbox(Number(viewImg.dataset.viewEntry), Number(viewImg.dataset.viewIdx)); return; }
        const rm = e.target.closest('[data-remove]');
        if (rm) { thread[Number(rm.dataset.removeImgEntry)].images.splice(Number(rm.dataset.remove), 1); triggerAutosave(); rerenderComposer(); return; }
        const mv = e.target.closest('[data-move]');
        if (mv) {
          const eIdx = Number(mv.dataset.moveEntry), i = Number(mv.dataset.move), d = Number(mv.dataset.dir);
          const imgs = thread[eIdx].images;
          [imgs[i], imgs[i + d]] = [imgs[i + d], imgs[i]];
          triggerAutosave(); renderAllImageGrids(); return;
        }
        const aa = e.target.closest('[data-auto-alt]');
        if (aa) { generateAlt(Number(aa.dataset.autoAltEntry), Number(aa.dataset.autoAlt)); return; }
      });
      grid.addEventListener('input', e => {
        const ai = e.target.closest('[data-alt-idx]');
        if (ai) { thread[Number(ai.dataset.altEntry)].images[Number(ai.dataset.altIdx)].alt = ai.value; triggerAutosave(); }
      });
    });

    // Add thread entry
    const atb = $('#add-thread-btn');
    if (atb) atb.addEventListener('click', () => { syncThreadFromDOM(); thread.push({ text: '', images: [] }); triggerAutosave(); rerenderComposer(); });

    // Remove thread entry
    $$('[data-remove-entry]').forEach(b => b.addEventListener('click', () => {
      const idx = Number(b.dataset.removeEntry);
      if (thread.length <= 1) return;
      syncThreadFromDOM();
      thread.splice(idx, 1);
      triggerAutosave();
      rerenderComposer();
    }));

    // Collapsible toggles
    $$('[data-toggle]').forEach(h => h.addEventListener('click', () => {
      if (h.dataset.toggle === 'bsky') bskySettingsOpen = !bskySettingsOpen;
      else fediSettingsOpen = !fediSettingsOpen;
      syncSettingsFromDOM(); rerenderComposer();
    }));

    // Label chips
    $$('.label-chip').forEach(c => c.addEventListener('click', () => {
      const l = c.dataset.label;
      bskyLabels = bskyLabels.includes(l) ? bskyLabels.filter(x => x !== l) : [...bskyLabels, l];
      syncSettingsFromDOM(); rerenderComposer();
    }));

    // Settings
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

    // Draft count & list
    loadDraftCount();
    const dc = $('#draft-count');
    if (dc) dc.addEventListener('click', toggleDraftsList);
    $$('[data-draft-restore]').forEach(b => b.addEventListener('click', () => restoreDraft(b.dataset.draftRestore)));
    $$('[data-draft-delete]').forEach(b => b.addEventListener('click', () => deleteDraft(b.dataset.draftDelete)));
    $$('[data-draft-img]').forEach(img => img.addEventListener('click', e => { e.stopPropagation(); openStaticLightbox(img.dataset.draftImg); }));
  }

  // ── Image handling ──
  function handlePaste(e, entryIdx) {
    const items = Array.from(e.clipboardData?.items || []).filter(i => i.type.startsWith('image/'));
    if (!items.length) return;
    e.preventDefault();
    uploadFiles(items.map(i => i.getAsFile()).filter(Boolean), entryIdx);
  }

  function handleDrop(e, entryIdx) {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
    if (files.length) uploadFiles(files, entryIdx);
  }

  let uploadingFlag = false;
  async function uploadFiles(files, entryIdx) {
    const entry = thread[entryIdx];
    if (!entry) return;
    const slots = 4 - entry.images.length;
    if (slots <= 0) { toast('Max 4 images per post', 'error'); return; }
    if (uploadingFlag) { toast('Upload in progress', 'error'); return; }
    files = files.slice(0, slots);
    const totalMB = files.reduce((s, f) => s + f.size, 0) / 1024 / 1024;

    const formData = new FormData();
    for (const f of files) formData.append('images', f);

    uploadingFlag = true;
    uploadTargetIdx = entryIdx;
    uploadProgress = 0;
    showUploadProgress(entryIdx);

    try {
      const data = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/posts/images');
        xhr.upload.addEventListener('progress', e => {
          if (e.lengthComputable) { uploadProgress = e.loaded / e.total; showUploadProgress(entryIdx); }
        });
        xhr.addEventListener('load', () => {
          try { const j = JSON.parse(xhr.responseText); xhr.status >= 400 ? reject(new Error(j.error || 'Upload failed')) : resolve(j); }
          catch { reject(new Error('Upload failed')); }
        });
        xhr.addEventListener('error', () => reject(new Error('Upload failed')));
        xhr.send(formData);
      });
      for (const img of data) entry.images.push({ ...img, alt: '' });
      triggerAutosave();
      toast(`Uploaded ${files.length} image${files.length > 1 ? 's' : ''} (${totalMB.toFixed(1)}MB)`, 'success');
    } catch (err) { toast(err.message || 'Upload failed', 'error'); }
    finally { uploadingFlag = false; rerenderComposer(); }
  }

  function showUploadProgress(entryIdx) {
    const area = $(`[data-entry-images="${entryIdx}"]`);
    if (!area) return;
    let bar = area.querySelector('.upload-progress');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'upload-progress';
      bar.innerHTML = '<div class="upload-progress-bar"></div><span class="upload-progress-text"></span>';
      area.prepend(bar);
    }
    const pct = Math.round(uploadProgress * 100);
    bar.querySelector('.upload-progress-bar').style.width = pct + '%';
    bar.querySelector('.upload-progress-text').textContent = pct < 100 ? `Uploading... ${pct}%` : 'Processing...';
  }

  // ── Alt text generation ──
  function altKey(eIdx, iIdx) { return `${eIdx}-${iIdx}`; }
  function isGeneratingAlt(eIdx, iIdx) { return !!altGenerating[altKey(eIdx, iIdx)]; }

  async function generateAlt(entryIdx, imgIdx) {
    const key = altKey(entryIdx, imgIdx);
    if (altGenerating[key]) { altGenerating[key].abort(); delete altGenerating[key]; updateAltUI(); return; }

    const controller = new AbortController();
    altGenerating[key] = controller;
    updateAltUI();

    try {
      const img = thread[entryIdx].images[imgIdx];
      const res = await fetch(`/api/posts/images/${img.filename}/alt`, { method: 'POST', signal: controller.signal });
      const data = await res.json();
      if (data.alt) {
        thread[entryIdx].images[imgIdx].alt = data.alt;
        const lbInput = document.querySelector('.lightbox-alt-input');
        const lb = document.querySelector('.lightbox');
        if (lbInput && lb && lb.dataset.entry == entryIdx && lb.dataset.idx == imgIdx) {
          lbInput.value = data.alt;
          lbInput.style.height = 'auto'; lbInput.style.height = lbInput.scrollHeight + 'px';
        }
        triggerAutosave();
      } else toast('Alt text generation failed', 'error');
    } catch (err) { if (err.name !== 'AbortError') toast('Alt text generation failed', 'error'); }
    finally { delete altGenerating[key]; updateAltUI(); renderAllImageGrids(); }
  }

  function updateAltUI() {
    $$('.auto-alt-btn').forEach(btn => {
      const e = Number(btn.dataset.autoAltEntry), i = Number(btn.dataset.autoAlt);
      const gen = isGeneratingAlt(e, i);
      btn.textContent = gen ? 'Stop' : 'AI';
      btn.classList.toggle('generating', gen);
    });
    $$('.alt-input').forEach(ta => {
      const e = Number(ta.dataset.altEntry), i = Number(ta.dataset.altIdx);
      ta.classList.toggle('alt-busy', isGeneratingAlt(e, i));
    });
    const lbBtn = document.querySelector('.lightbox-ai-btn');
    const lb = document.querySelector('.lightbox');
    if (lbBtn && lb) {
      const gen = isGeneratingAlt(Number(lb.dataset.entry), Number(lb.dataset.idx));
      lbBtn.textContent = gen ? 'Stop generating' : 'Generate alt text';
      lbBtn.classList.toggle('generating', gen);
      const lbInput = document.querySelector('.lightbox-alt-input');
      if (lbInput) lbInput.classList.toggle('alt-busy', gen);
    }
  }

  // ── Lightbox ──
  function openLightbox(entryIdx, imgIdx) {
    const img = thread[entryIdx]?.images[imgIdx];
    if (!img) return;
    const gen = isGeneratingAlt(entryIdx, imgIdx);
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.dataset.entry = entryIdx;
    lb.dataset.idx = imgIdx;
    lb.innerHTML = `
      <div class="lightbox-content">
        <img src="/api/posts/images/${img.filename}" />
        <div class="lightbox-alt">
          <textarea class="lightbox-alt-input ${gen ? 'alt-busy' : ''}" placeholder="Alt text...">${esc(img.alt || '')}</textarea>
          <button class="lightbox-ai-btn ${gen ? 'generating' : ''}">${gen ? 'Stop generating' : 'Generate alt text'}</button>
        </div>
      </div>`;
    lb.addEventListener('click', e => { if (e.target === lb) closeLightbox(lb, entryIdx, imgIdx); });
    const onKey = e => { if (e.key === 'Escape') { closeLightbox(lb, entryIdx, imgIdx); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    lb.querySelector('.lightbox-ai-btn').addEventListener('click', () => generateAlt(entryIdx, imgIdx));
    const lbTa = lb.querySelector('.lightbox-alt-input');
    const autoGrow = () => { lbTa.style.height = 'auto'; lbTa.style.height = lbTa.scrollHeight + 'px'; };
    lbTa.addEventListener('input', e => { thread[entryIdx].images[imgIdx].alt = e.target.value; autoGrow(); triggerAutosave(); });
    document.body.appendChild(lb);
    autoGrow();
  }

  function closeLightbox(lb, entryIdx, imgIdx) {
    const ta = lb.querySelector('.lightbox-alt-input');
    if (ta) { thread[entryIdx].images[imgIdx].alt = ta.value; renderAllImageGrids(); }
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

  // ── Autosave ──
  function triggerAutosave() { clearTimeout(autosaveTimer); autosaveTimer = setTimeout(doAutosave, 800); }

  async function doAutosave() {
    syncThreadFromDOM();
    try {
      await fetch('/api/drafts/active', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread, targets: target, parentId: replyTo?.id || null }),
      });
      flashAutosave();
    } catch {}
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
    syncThreadFromDOM();
    const hasContent = thread.some(e => (e.text || '').trim() || e.images.length);
    if (!hasContent) { toast('Nothing to stash', 'error'); return; }
    syncSettingsFromDOM();
    await doAutosave();
    const res = await fetch('/api/drafts/stash', { method: 'POST' });
    const data = await res.json();
    if (data.stashed) {
      toast('Draft stashed', 'success');
      thread = [{ text: '', images: [] }];
      replyTo = null; showDraftsList = false;
      freshRenderComposer();
      loadDraftCount();
    }
  }

  function toggleDraftsList() { showDraftsList = !showDraftsList; syncThreadFromDOM(); syncSettingsFromDOM(); rerenderComposer(); }

  async function restoreDraft(id) {
    syncThreadFromDOM();
    const hasContent = thread.some(e => (e.text || '').trim() || e.images.length);
    if (hasContent) { syncSettingsFromDOM(); await doAutosave(); await fetch('/api/drafts/stash', { method: 'POST' }); }

    const res = await fetch(`/api/drafts/${id}/restore`, { method: 'POST' });
    const draft = await res.json();
    target = draft.targets || 'both';
    try { thread = JSON.parse(draft.thread); } catch { thread = [{ text: '', images: [] }]; }
    if (!thread.length) thread = [{ text: '', images: [] }];
    replyTo = draft.parent_id ? { id: draft.parent_id, text: '(restored draft)', targets: target } : null;
    showDraftsList = false;
    freshRenderComposer();
    await loadDraftCount();
    toast('Draft restored', 'success');
  }

  async function deleteDraft(id) {
    await fetch(`/api/drafts/${id}`, { method: 'DELETE' });
    await loadDraftCount();
    syncThreadFromDOM(); syncSettingsFromDOM(); rerenderComposer();
    toast('Draft deleted', 'success');
  }

  // ── Post ──
  async function handlePost() {
    syncThreadFromDOM(); syncSettingsFromDOM();
    const hasContent = thread.some(e => e.text.trim());
    if (!hasContent) return;
    const pb = $('#post-btn');
    pb.disabled = true;
    pb.textContent = showSchedule ? 'Scheduling...' : (thread.length > 1 ? 'Posting thread...' : 'Posting...');

    const body = {
      thread: thread.map(e => ({ text: e.text, images: e.images.map(i => ({ id: i.id, filename: i.filename, mimeType: i.mimeType, alt: i.alt })) })),
      targets: target,
      visibility: fediVisibility,
      contentWarning: fediCW || '',
      parentId: replyTo?.id || null,
      scheduledAt: showSchedule ? ($('#schedule-time')?.value ? new Date($('#schedule-time').value).toISOString() : null) : null,
      blueskyLabels: bskyLabels.length ? bskyLabels : null,
      blueskyThreadgate: bskyThreadgate,
    };

    if (showSchedule && !body.scheduledAt) { toast('Pick a time', 'error'); pb.disabled = false; pb.textContent = 'Schedule'; return; }

    try {
      const res = await fetch('/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error || 'Failed', 'error'); pb.disabled = false; pb.textContent = showSchedule ? 'Schedule' : 'Post now'; return; }

      // Check results
      if (data.thread) {
        const failures = data.thread.filter(r => r.result && ((r.result.bluesky && !r.result.bluesky.success) || (r.result.fedi && !r.result.fedi.success)));
        if (failures.length) toast(`Thread posted with ${failures.length} error(s)`, 'error');
        else toast(`Thread posted (${data.thread.length} posts)!`, 'success');
      } else if (data.result) {
        const b = data.result.bluesky, f = data.result.fedi;
        if (b && !b.success && f && f.success) toast('Posted to Fedi, Bluesky failed', 'error');
        else if (f && !f.success && b && b.success) toast('Posted to Bluesky, Fedi failed', 'error');
        else if (b && !b.success && f && !f.success) toast('Both failed', 'error');
        else toast('Posted!', 'success');
      } else toast('Scheduled!', 'success');

      clearTimeout(autosaveTimer);
      await fetch('/api/drafts/active', { method: 'DELETE' });
      replyTo = null; thread = [{ text: '', images: [] }]; showSchedule = false;
      fediCW = ''; bskyLabels = []; bskyThreadgate = 'everyone'; fediVisibility = 'public';
      bskySettingsOpen = false; fediSettingsOpen = false;
      freshRenderComposer();
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
        triggerAutosave(); rerenderComposer();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (act === 'retry') {
        b.disabled = true; b.textContent = 'Retrying...';
        await fetch(`/api/posts/${id}/retry`, { method: 'POST' });
        toast('Retried', 'success'); loadTimeline();
      } else if (act === 'delete') {
        if (await confirmModal('Delete this post? Only removes from Crosspost, not from platforms.')) {
          await fetch(`/api/posts/${id}`, { method: 'DELETE' });
          toast('Deleted', 'success'); loadTimeline();
        }
      }
    }));
  }

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
        if (await confirmModal('Delete this post? Only removes from Crosspost, not from platforms.')) {
          await fetch(`/api/posts/${b.dataset.postId}`, { method: 'DELETE' });
          toast('Deleted', 'success'); loadTimeline();
        }
      }
    }));
  }

  // ── Helpers ──
  function autoGrowTextarea(el) { el.style.height = 'auto'; el.style.height = Math.max(el.scrollHeight, 120) + 'px'; }
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
  function confirmModal(msg) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      overlay.innerHTML = `
        <div class="confirm-dialog">
          <p class="confirm-msg">${esc(msg)}</p>
          <div class="confirm-actions">
            <button class="confirm-cancel">Cancel</button>
            <button class="confirm-ok">Delete</button>
          </div>
        </div>`;
      const close = val => { overlay.remove(); resolve(val); };
      overlay.querySelector('.confirm-cancel').addEventListener('click', () => close(false));
      overlay.querySelector('.confirm-ok').addEventListener('click', () => close(true));
      overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });
      document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') { close(false); document.removeEventListener('keydown', onKey); }
      });
      document.body.appendChild(overlay);
      overlay.querySelector('.confirm-cancel').focus();
    });
  }

  function toast(msg, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  init();
})();
