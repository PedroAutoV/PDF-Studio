/* ============================================================
   PDF Studio — lógica da aplicação (100% client-side)
   - pdf.js    : renderização de miniaturas e da página principal
   - pdf-lib   : manipulação e exportação do PDF
   - interact  : arrastar/redimensionar elementos no toque e mouse
   ============================================================ */
(() => {
  'use strict';

  /* ---------------- utilidades ---------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
  const mod = (n, m) => ((n % m) + m) % m;

  // APIs do pdf-lib (o script CDN já foi carregado antes deste arquivo)
  const { PDFDocument, StandardFonts, degrees, rgb } = window.PDFLib || {};

  /* ---------------- estado ---------------- */
  const state = {
    fileName: null,
    pdfBytes: null,        // cópia dos bytes originais (para exportar)
    doc: null,             // documento pdf.js
    pages: [],             // { id, srcIndex, baseRotation, rotation, mw, mh, selected, thumbCanvas }
    elements: new Map(),   // pageId -> [elemento]
    activePageId: null,
    selectedElementId: null,
    scale: 1,              // px por ponto na visualização atual
    seq: 1,
    thumbToken: 0,
    // modo "editar texto existente" (estilo Acrobat)
    editMode: false,
    edits: new Map(),      // pageId -> Map(itemIndex -> { text, color })
    textCache: new Map(),  // srcIndex -> { items, styles } do getTextContent()
    editSel: null,         // índice do trecho selecionado na camada de edição
    editDefaultColor: '#111827',
  };

  let previewToken = 0;
  let previewRenderTask = null;
  let textLayerToken = 0;
  let dragPageId = null;

  const els = {};

  /* ---------------- init ---------------- */
  function init() {
    ['fileInput', 'openBtn', 'emptyOpenBtn', 'rotateLBtn', 'rotateRBtn', 'moveLBtn',
     'moveRBtn', 'deleteBtn', 'textBtn', 'editTextBtn', 'sigBtn', 'exportBtn', 'fileName', 'pageCount',
     'selectAllBtn', 'thumbGrid', 'stageBox', 'previewStage', 'emptyState', 'pageWrap',
     'pageCanvas', 'textLayer', 'overlay', 'elementBar', 'textEditBar', 'revertEditBtn', 'elEditBtn', 'elDeleteBtn', 'toast', 'busy',
     'busyMsg', 'textModal', 'textTitle', 'txtContent', 'txtSize', 'txtColor', 'txtBold',
     'txtOk', 'txtCancel', 'sigModal', 'sigPanelDraw', 'sigPanelUpload', 'sigCanvas',
     'sigClear', 'sigCancel', 'sigUse', 'sigFile', 'sigPreview', 'sigPreviewWrap',
     'sigUseUpload', 'sigCancel2'
    ].forEach(id => { els[id] = document.getElementById(id); });

    if (!window.pdfjsLib || !window.PDFLib || !window.interact) {
      document.body.insertAdjacentHTML('beforeend',
        '<div class="lib-error">Falha ao carregar as bibliotecas via CDN. Verifique sua conexão e recarregue a página.</div>');
      return;
    }

    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    bindToolbar();
    bindSignatureModal();
    bindTextModal();
    bindKeyboard();
    bindStageDrop();
    observeResize();
  }

  /* ---------------- helpers de estado ---------------- */
  const getActive = () => state.pages.find(p => p.id === state.activePageId) || null;
  const findElement = id => {
    for (const list of state.elements.values()) {
      const e = list.find(x => x.id === id);
      if (e) return e;
    }
    return null;
  };

  // dimensões (em pontos) da página ativa no formato visual atual
  function activeDims() {
    const p = getActive();
    if (!p) return { w: 800, h: 600 };
    const T = mod(p.baseRotation + p.rotation, 360);
    return T % 180 === 0 ? { w: p.mw, h: p.mh } : { w: p.mh, h: p.mw };
  }

  /* ---------------- feedback ---------------- */
  let toastTimer;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2800);
  }
  function setBusy(on, msg) {
    els.busy.classList.toggle('hidden', !on);
    if (msg) els.busyMsg.textContent = msg;
  }

  /* ---------------- carregamento ---------------- */
  function requireDoc() {
    if (!state.doc) { toast('Abra um PDF primeiro.'); return false; }
    return true;
  }

  async function loadFile(file) {
    if (!file) return;
    if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) {
      toast('Selecione um arquivo PDF válido.');
      return;
    }
    setBusy(true, 'Carregando PDF...');
    try {
      const buf = await file.arrayBuffer();
      const forExport = new Uint8Array(buf.slice(0)); // cópia para o pdf-lib
      const forView = new Uint8Array(buf.slice(0));   // cópia para o pdf.js
      const doc = await pdfjsLib.getDocument({ data: forView }).promise;

      state.doc = doc;
      state.pdfBytes = forExport;
      state.fileName = file.name;
      state.pages = [];
      state.elements.clear();
      state.edits.clear();
      state.textCache.clear();
      state.editSel = null;
      state.editMode = false;
      state.selectedElementId = null;
      state.seq = 1;

      for (let i = 0; i < doc.numPages; i++) {
        const pg = await doc.getPage(i + 1);
        const vp0 = pg.getViewport({ scale: 1, rotation: 0 });
        const id = 'p' + (state.seq++);
        state.pages.push({
          id, srcIndex: i,
          baseRotation: mod(pg.rotate || 0, 360),
          rotation: 0,
          mw: vp0.width, mh: vp0.height,
          selected: false,
          thumbCanvas: null,
        });
        state.elements.set(id, []);
      }
      state.activePageId = state.pages[0].id;

      els.fileName.textContent = file.name;
      els.emptyState.classList.add('hidden');
      els.pageWrap.classList.remove('hidden');

      await renderThumbnails();
      renderPreview();
      toast(`"${file.name}" carregado — ${doc.numPages} página(s).`);
    } catch (err) {
      console.error(err);
      toast('Erro ao abrir o PDF: ' + (err && err.message ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- miniaturas ---------------- */
  async function renderThumb(pageObj) {
    const page = await state.doc.getPage(pageObj.srcIndex + 1);
    const rot = mod(pageObj.baseRotation + pageObj.rotation, 360);
    const base = page.getViewport({ scale: 1, rotation: rot });
    const scale = 150 / base.width;
    const vp = page.getViewport({ scale, rotation: rot });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(vp.width));
    canvas.height = Math.max(1, Math.ceil(vp.height));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    pageObj.thumbCanvas = canvas;
  }

  function thumbLabelHtml(p, index) {
    return `<span class="thumb-num">${index + 1}</span>` +
      (p.rotation ? `<span class="thumb-badge">${p.rotation}°</span>` : '');
  }

  function buildThumbCard(p, index) {
    const card = document.createElement('div');
    card.className = 'thumb-card' + (p.id === state.activePageId ? ' active' : '');
    card.dataset.id = p.id;
    card.draggable = true;
    card.innerHTML =
      `<button class="thumb-check${p.selected ? ' checked' : ''}" title="Marcar página para exclusão"><span>✓</span></button>
       <div class="thumb-canvas"></div>
       <div class="thumb-label">${thumbLabelHtml(p, index)}</div>`;

    card.addEventListener('click', e => {
      if (e.target.closest('.thumb-check')) return;
      selectPage(p.id);
    });

    card.querySelector('.thumb-check').addEventListener('click', e => {
      e.stopPropagation();
      p.selected = !p.selected;
      e.currentTarget.classList.toggle('checked', p.selected);
      updateCounts();
    });

    // reordenar por arrastar (desktop; no tablet use os botões ◀ ▶)
    card.addEventListener('dragstart', e => {
      dragPageId = p.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', p.id);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      dragPageId = null;
      card.classList.remove('dragging');
      $$('.thumb-card').forEach(c => c.classList.remove('drag-over'));
    });
    card.addEventListener('dragover', e => {
      if (!dragPageId || dragPageId === p.id) return;
      e.preventDefault();
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation();
      reorderTo(dragPageId, p.id);
    });

    return card;
  }

  async function renderThumbnails() {
    const token = ++state.thumbToken;
    const frag = document.createDocumentFragment();
    state.pages.forEach((p, i) => frag.appendChild(buildThumbCard(p, i)));
    els.thumbGrid.replaceChildren(frag);
    updateCounts();

    for (const p of state.pages) {
      if (token !== state.thumbToken) return;
      const card = els.thumbGrid.querySelector(`.thumb-card[data-id="${p.id}"]`);
      if (!card) continue;
      const holder = card.querySelector('.thumb-canvas');
      if (!p.thumbCanvas) {
        holder.innerHTML = '<div class="thumb-loading"></div>';
        try { await renderThumb(p); } catch (err) { console.warn(err); }
        if (token !== state.thumbToken) return;
        holder.innerHTML = '';
      }
      if (p.thumbCanvas) holder.appendChild(p.thumbCanvas);
    }
  }

  async function refreshThumb(p) {
    const card = els.thumbGrid.querySelector(`.thumb-card[data-id="${p.id}"]`);
    if (!card) return;
    p.thumbCanvas = null;
    const holder = card.querySelector('.thumb-canvas');
    holder.innerHTML = '<div class="thumb-loading"></div>';
    try { await renderThumb(p); } catch (err) { console.warn(err); }
    holder.innerHTML = '';
    if (p.thumbCanvas) holder.appendChild(p.thumbCanvas);
    card.querySelector('.thumb-label').innerHTML = thumbLabelHtml(p, state.pages.indexOf(p));
  }

  function updateCounts() {
    const sel = state.pages.filter(p => p.selected).length;
    els.pageCount.textContent = state.pages.length;
    els.deleteBtn.querySelector('.lbl').textContent = sel ? `Excluir (${sel})` : 'Excluir';
  }

  /* ---------------- operações de página ---------------- */
  function selectPage(id) {
    if (state.activePageId === id) return;
    state.activePageId = id;
    state.selectedElementId = null;
    $$('.thumb-card').forEach(c => c.classList.toggle('active', c.dataset.id === id));
    renderPreview();
  }

  function rotateActive(cw) {
    const p = getActive();
    if (!requireDoc() || !p) return;
    const dims = activeDims(); // dimensões visuais ANTES da rotação
    (state.elements.get(p.id) || []).forEach(e => transformElement(e, cw ? 1 : -1, dims));
    p.rotation = mod(p.rotation + (cw ? 90 : 270), 360);
    state.selectedElementId = null;
    refreshThumb(p);
    renderPreview();
  }

  function moveActive(dir) {
    if (!requireDoc()) return;
    const i = state.pages.findIndex(p => p.id === state.activePageId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= state.pages.length) return;
    const tmp = state.pages[i];
    state.pages[i] = state.pages[j];
    state.pages[j] = tmp;
    renderThumbnails();
  }

  function reorderTo(dragId, targetId) {
    if (!dragId || dragId === targetId) return;
    const from = state.pages.findIndex(p => p.id === dragId);
    let to = state.pages.findIndex(p => p.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = state.pages.splice(from, 1);
    if (from < to) to -= 1;
    state.pages.splice(to, 0, moved);
    renderThumbnails();
  }

  function deleteSelectedPages() {
    if (!requireDoc()) return;
    const targets = state.pages.filter(p => p.selected);
    if (!targets.length) {
      toast('Marque as caixas ✓ das miniaturas para excluir em lote.');
      return;
    }
    if (targets.length >= state.pages.length) {
      toast('O documento precisa manter ao menos uma página.');
      return;
    }
    if (!confirm(`Excluir ${targets.length} página(s)?`)) return;
    const ids = new Set(targets.map(p => p.id));
    state.pages = state.pages.filter(p => !ids.has(p.id));
    ids.forEach(id => { state.elements.delete(id); state.edits.delete(id); });
    if (ids.has(state.activePageId)) state.activePageId = state.pages[0].id;
    state.selectedElementId = null;
    renderThumbnails();
    renderPreview();
  }

  /* ---------------- preview da página ativa ---------------- */
  async function renderPreview() {
    const p = getActive();
    if (!p || !state.doc) return;
    const token = ++previewToken;

    const page = await state.doc.getPage(p.srcIndex + 1);
    if (token !== previewToken) return;

    const rot = mod(p.baseRotation + p.rotation, 360);
    const base = page.getViewport({ scale: 1, rotation: rot });
    const box = els.stageBox;
    const availW = Math.max(120, box.clientWidth - 12);
    const availH = Math.max(120, box.clientHeight - 12);
    const scale = Math.min(availW / base.width, availH / base.height);
    const vp = page.getViewport({ scale, rotation: rot });

    const canvas = els.pageCanvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(vp.width * dpr));
    canvas.height = Math.max(1, Math.floor(vp.height * dpr));
    canvas.style.width = Math.floor(vp.width) + 'px';
    canvas.style.height = Math.floor(vp.height) + 'px';

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (previewRenderTask) { try { previewRenderTask.cancel(); } catch (_) {} }
    previewRenderTask = page.render({
      canvasContext: ctx,
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    try { await previewRenderTask.promise; } catch (_) { /* cancelado */ }
    if (token !== previewToken) return;

    state.scale = scale;
    els.pageWrap.style.width = Math.floor(vp.width) + 'px';
    els.pageWrap.style.height = Math.floor(vp.height) + 'px';
    renderElements();
    renderTextLayer();
  }

  function observeResize() {
    let t;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => { if (state.doc) renderPreview(); }, 180);
    });
    ro.observe(els.stageBox);
  }

  /* ---------------- elementos sobrepostos ---------------- */
  function applyElementStyle(div, e) {
    div.style.left = (e.x * state.scale) + 'px';
    div.style.top = (e.y * state.scale) + 'px';
    div.style.width = (e.w * state.scale) + 'px';
    div.style.height = (e.h * state.scale) + 'px';
  }

  function renderElements() {
    els.overlay.replaceChildren();
    const list = state.elements.get(state.activePageId) || [];
    list.forEach(e => {
      const div = document.createElement('div');
      div.dataset.id = e.id;
      div.className = 'pdf-element ' + (e.type === 'text' ? 'el-text' : 'el-sign') +
        (state.selectedElementId === e.id ? ' selected' : '');

      if (e.type === 'text') {
        const inner = document.createElement('div');
        inner.className = 'el-text-inner';
        inner.textContent = e.text;
        inner.style.fontSize = (e.fontSize * state.scale) + 'px';
        inner.style.color = e.color;
        inner.style.fontWeight = e.bold ? '700' : '400';
        div.appendChild(inner);
      } else {
        const img = document.createElement('img');
        img.src = e.dataUrl;
        img.alt = 'Assinatura';
        div.appendChild(img);
      }

      applyElementStyle(div, e);

      // alvo de redimensionamento: canto superior direito
      const handle = document.createElement('div');
      handle.className = 'resize-handle';
      handle.title = 'Redimensionar';
      handle.innerHTML = '<span>⤡</span>';
      div.appendChild(handle);

      attachInteractions(div, e, handle);

      div.addEventListener('click', ev => { ev.stopPropagation(); selectElement(e.id); });
      div.addEventListener('dblclick', ev => {
        ev.stopPropagation();
        if (e.type === 'text') openTextModal(e);
      });

      els.overlay.appendChild(div);
    });
    updateElementBar();
  }

  function attachInteractions(div, e, handle) {
    interact(div)
      .draggable({
        listeners: {
          start() { selectElement(e.id); div.classList.add('dragging'); },
          move(ev) {
            const dims = activeDims();
            e.x = clamp(e.x + ev.dx / state.scale, 0, Math.max(0, dims.w - e.w));
            e.y = clamp(e.y + ev.dy / state.scale, 0, Math.max(0, dims.h - e.h));
            applyElementStyle(div, e);
          },
          end() { div.classList.remove('dragging'); },
        },
      })
      .resizable({
        // somente o botão do canto superior direito redimensiona;
        // o restante do elemento move
        edges: { top: handle, right: handle },
        listeners: {
          move(ev) {
            const dims = activeDims();
            const s = state.scale;
            const minW = e.type === 'text' ? 40 : 20;
            const minH = e.type === 'text' ? 14 : 20;
            let w = clamp(e.w + ev.deltaRect.width / s, minW, dims.w);
            let h = clamp(e.h + ev.deltaRect.height / s, minH, dims.h);
            e.x = clamp(e.x + ev.deltaRect.left / s, 0, dims.w - w);
            e.y = clamp(e.y + ev.deltaRect.top / s, 0, dims.h - h);
            e.w = w;
            e.h = h;
            applyElementStyle(div, e);
          },
        },
      });
  }

  function selectElement(id) {
    state.selectedElementId = id;
    $$('.pdf-element', els.overlay).forEach(div => {
      div.classList.toggle('selected', div.dataset.id === id);
    });
    updateElementBar();
  }

  function updateElementBar() {
    const e = state.selectedElementId ? findElement(state.selectedElementId) : null;
    els.elementBar.classList.toggle('hidden', !e);
    els.elementBar.classList.toggle('inline-flex', !!e);
    els.elEditBtn.classList.toggle('hidden', !e || e.type !== 'text');
  }

  function addElement(e) {
    const list = state.elements.get(state.activePageId) || [];
    list.push(e);
    state.elements.set(state.activePageId, list);
  }

  function deleteSelectedElement() {
    const id = state.selectedElementId;
    if (!id) return;
    const list = state.elements.get(state.activePageId) || [];
    const i = list.findIndex(e => e.id === id);
    if (i >= 0) list.splice(i, 1);
    state.selectedElementId = null;
    renderElements();
  }

  // converte o elemento entre os frames visual ao girar a página 90°
  function transformElement(e, dir, dims) {
    if (dir === 1) { // horário
      const nx = dims.h - (e.y + e.h);
      const ny = e.x;
      e.x = nx; e.y = ny;
    } else {          // anti-horário
      const nx = e.y;
      const ny = dims.w - (e.x + e.w);
      e.x = nx; e.y = ny;
    }
    const t = e.w; e.w = e.h; e.h = t;
  }

  /* ---------------- modal de texto ---------------- */
  function openTextModal(existing) {
    if (!requireDoc()) return;
    els.textModal.classList.remove('hidden');
    els.textTitle.textContent = existing ? 'Editar texto' : 'Adicionar texto';
    els.txtContent.value = existing ? existing.text : '';
    els.txtSize.value = existing ? existing.fontSize : 16;
    els.txtColor.value = existing ? existing.color : '#111827';
    els.txtBold.checked = existing ? !!existing.bold : false;
    els.textModal.dataset.editing = existing ? existing.id : '';
    setTimeout(() => els.txtContent.focus(), 50);
  }

  function saveTextFromModal() {
    const text = els.txtContent.value.replace(/\r/g, '');
    if (!text.trim()) { toast('Digite algum texto.'); return; }
    const size = clamp(parseFloat(els.txtSize.value) || 16, 6, 144);
    const color = els.txtColor.value || '#111827';
    const bold = els.txtBold.checked;
    const editingId = els.textModal.dataset.editing;
    const needed = text.split('\n').length * size * 1.3 + 4;

    if (editingId) {
      const e = findElement(editingId);
      if (e) {
        e.text = text; e.fontSize = size; e.color = color; e.bold = bold;
        e.h = Math.max(e.h, needed);
      }
    } else {
      const dims = activeDims();
      const w = Math.min(320, dims.w * 0.75);
      const h = Math.max(24, needed);
      const e = {
        id: 'e' + (state.seq++), type: 'text',
        x: (dims.w - w) / 2, y: (dims.h - h) / 2, w, h,
        text, fontSize: size, color, bold,
      };
      addElement(e);
      state.selectedElementId = e.id;
    }
    els.textModal.classList.add('hidden');
    renderElements();
  }

  /* ---------------- modal de assinatura ---------------- */
  const sig = { ink: false, drawing: false, dataUrl: null, iw: 0, ih: 0, mime: 'png' };

  function bindSignatureModal() {
    $$('.tab', els.sigModal).forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.tab', els.sigModal).forEach(t => t.classList.toggle('active', t === tab));
        const draw = tab.dataset.tab === 'draw';
        els.sigPanelDraw.classList.toggle('hidden', !draw);
        els.sigPanelUpload.classList.toggle('hidden', draw);
        if (draw) requestAnimationFrame(sizeSigCanvas);
      });
    });

    els.sigBtn.addEventListener('click', openSigModal);
    els.sigCancel.addEventListener('click', closeSigModal);
    els.sigCancel2.addEventListener('click', closeSigModal);
    els.sigClear.addEventListener('click', () => { clearSigCanvas(); sig.ink = false; });
    els.sigUse.addEventListener('click', useDrawnSignature);
    els.sigFile.addEventListener('change', onSigFile);
    els.sigUseUpload.addEventListener('click', useUploadedSignature);

    const c = els.sigCanvas;
    c.addEventListener('pointerdown', ev => {
      ev.preventDefault();
      c.setPointerCapture(ev.pointerId);
      sig.drawing = true;
      const pt = sigPoint(ev);
      const ctx = c.getContext('2d');
      ctx.beginPath();
      ctx.moveTo(pt.x, pt.y);
    });
    c.addEventListener('pointermove', ev => {
      if (!sig.drawing) return;
      const pt = sigPoint(ev);
      const ctx = c.getContext('2d');
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
      sig.ink = true;
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(t =>
      c.addEventListener(t, () => { sig.drawing = false; }));
  }

  function openSigModal() {
    if (!requireDoc()) return;
    els.sigModal.classList.remove('hidden');
    $$('.tab', els.sigModal).forEach((t, i) => t.classList.toggle('active', i === 0));
    els.sigPanelDraw.classList.remove('hidden');
    els.sigPanelUpload.classList.add('hidden');
    els.sigPreviewWrap.classList.add('hidden');
    els.sigUseUpload.disabled = true;
    els.sigFile.value = '';
    sig.dataUrl = null; sig.ink = false;
    requestAnimationFrame(sizeSigCanvas);
  }

  function closeSigModal() {
    els.sigModal.classList.add('hidden');
  }

  function sizeSigCanvas() {
    const c = els.sigCanvas;
    const rect = c.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(rect.width * dpr);
    c.height = Math.round(rect.height * dpr);
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1d4ed8'; // tinta azul (visível em páginas brancas)
  }

  function clearSigCanvas() {
    const c = els.sigCanvas;
    const ctx = c.getContext('2d');
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.restore();
  }

  function sigPoint(ev) {
    const r = els.sigCanvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  // recorta a imagem ao redor do traçado, mantendo fundo transparente
  function cropCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    const { width: w, height: h } = canvas;
    const data = ctx.getImageData(0, 0, w, h).data;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    const pad = 8;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
    const cw = maxX - minX + 1, ch = maxY - minY + 1;
    const out = document.createElement('canvas');
    out.width = cw; out.height = ch;
    out.getContext('2d').drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
    return { dataUrl: out.toDataURL('image/png'), w: cw, h: ch };
  }

  function useDrawnSignature() {
    if (!sig.ink) { toast('Desenhe sua assinatura primeiro.'); return; }
    const cropped = cropCanvas(els.sigCanvas);
    if (!cropped) { toast('Não foi possível capturar a assinatura.'); return; }
    createSignatureElement(cropped.dataUrl, cropped.w, cropped.h, 'png');
  }

  function onSigFile(ev) {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    if (!/^image\/(png|jpeg)$/.test(f.type)) { toast('Envie uma imagem PNG ou JPG.'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        sig.dataUrl = reader.result;
        sig.iw = img.naturalWidth;
        sig.ih = img.naturalHeight;
        sig.mime = f.type === 'image/jpeg' ? 'jpg' : 'png';
        els.sigPreview.src = reader.result;
        els.sigPreviewWrap.classList.remove('hidden');
        els.sigUseUpload.disabled = false;
      };
      img.onerror = () => toast('Não foi possível ler a imagem.');
      img.src = reader.result;
    };
    reader.readAsDataURL(f);
  }

  function useUploadedSignature() {
    if (!sig.dataUrl) { toast('Envie uma imagem primeiro.'); return; }
    createSignatureElement(sig.dataUrl, sig.iw, sig.ih, sig.mime);
  }

  function createSignatureElement(dataUrl, iw, ih, mime) {
    const dims = activeDims();
    let w = Math.min(200, dims.w * 0.45);
    let h = w * (ih / iw);
    if (h > dims.h * 0.4) { h = dims.h * 0.4; w = h * (iw / ih); }
    const e = {
      id: 'e' + (state.seq++), type: 'signature',
      x: (dims.w - w) / 2, y: (dims.h - h) / 2, w, h,
      dataUrl, mime,
    };
    addElement(e);
    state.selectedElementId = e.id;
    closeSigModal();
    renderElements();
    toast('Assinatura adicionada — arraste para posicionar.');
  }

  /* ---------------- toolbar / stage / teclado ---------------- */
  function bindToolbar() {
    const openPicker = () => els.fileInput.click();
    els.openBtn.addEventListener('click', openPicker);
    els.emptyOpenBtn.addEventListener('click', ev => { ev.stopPropagation(); openPicker(); });
    els.fileInput.addEventListener('change', ev => {
      const f = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (f) loadFile(f);
    });

    els.rotateLBtn.addEventListener('click', () => rotateActive(false));
    els.rotateRBtn.addEventListener('click', () => rotateActive(true));
    els.moveLBtn.addEventListener('click', () => moveActive(-1));
    els.moveRBtn.addEventListener('click', () => moveActive(1));
    els.deleteBtn.addEventListener('click', deleteSelectedPages);
    els.textBtn.addEventListener('click', () => { if (requireDoc()) openTextModal(null); });
    els.exportBtn.addEventListener('click', exportPdf);

    // modo "editar texto existente"
    els.editTextBtn.addEventListener('click', () => {
      if (!requireDoc()) return;
      state.editMode = !state.editMode;
      state.editSel = null;
      els.editTextBtn.classList.toggle('btn-on', state.editMode);
      els.textEditBar.classList.toggle('hidden', !state.editMode);
      els.textEditBar.classList.toggle('flex', state.editMode);
      renderTextLayer();
      toast(state.editMode
        ? 'Modo edição: toque num texto do PDF para corrigir.'
        : 'Modo edição desligado.');
    });

    $$('.color-chip', els.textEditBar).forEach(chip => {
      chip.addEventListener('click', () => {
        const color = chip.dataset.color;
        state.editDefaultColor = color;
        const p = getActive();
        if (p && state.editSel != null) {
          const em = state.edits.get(p.id);
          if (em && em.get(state.editSel)) {
            em.get(state.editSel).color = color;
            renderTextLayer();
          }
        }
      });
    });

    els.revertEditBtn.addEventListener('click', () => {
      const p = getActive();
      if (p && state.editSel != null) {
        const em = state.edits.get(p.id);
        if (em && em.delete(state.editSel)) {
          renderTextLayer();
          toast('Trecho revertido ao original.');
          return;
        }
      }
      toast('Toque num texto editado (verde) para reverter.');
    });

    els.selectAllBtn.addEventListener('click', () => {
      if (!requireDoc()) return;
      const all = state.pages.every(p => p.selected);
      state.pages.forEach(p => { p.selected = !all; });
      $$('.thumb-check', els.thumbGrid).forEach(b => b.classList.toggle('checked', !all));
      updateCounts();
    });

    els.overlay.addEventListener('click', () => selectElement(null));
    els.elEditBtn.addEventListener('click', () => {
      const e = state.selectedElementId ? findElement(state.selectedElementId) : null;
      if (e && e.type === 'text') openTextModal(e);
    });
    els.elDeleteBtn.addEventListener('click', deleteSelectedElement);
  }

  function bindStageDrop() {
    const stage = els.previewStage;
    ['dragenter', 'dragover'].forEach(t =>
      stage.addEventListener(t, e => {
        e.preventDefault();
        if (!state.doc) els.emptyState.classList.add('drag-over');
      }));
    ['dragleave', 'drop'].forEach(t =>
      stage.addEventListener(t, () => els.emptyState.classList.remove('drag-over')));
    stage.addEventListener('drop', e => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });
    // evita que o navegador abra o arquivo ao soltar fora da zona
    ['dragover', 'drop'].forEach(t => window.addEventListener(t, e => {
      if (!(e.target instanceof Element) || !e.target.closest('#previewStage')) e.preventDefault();
    }));
  }

  function bindTextModal() {
    els.textBtn.addEventListener('dblclick', e => e.preventDefault());
    els.txtOk.addEventListener('click', saveTextFromModal);
    els.txtCancel.addEventListener('click', () => els.textModal.classList.add('hidden'));
    els.textModal.addEventListener('click', ev => {
      if (ev.target === els.textModal) els.textModal.classList.add('hidden');
    });
    els.sigModal.addEventListener('click', ev => {
      if (ev.target === els.sigModal) closeSigModal();
    });
  }

  function bindKeyboard() {
    document.addEventListener('keydown', ev => {
      const ae = document.activeElement;
      const typing = /^(INPUT|TEXTAREA)$/.test(ae.tagName) || ae.isContentEditable;
      if (ev.key === 'Escape') {
        els.textModal.classList.add('hidden');
        closeSigModal();
        selectElement(null);
      }
      if (!typing && (ev.key === 'Delete' || ev.key === 'Backspace') && state.selectedElementId) {
        ev.preventDefault();
        deleteSelectedElement();
      }
    });
  }

  /* ---------------- edição de texto existente (estilo Acrobat) ------------- */
  // Une trechos vizinhos da mesma linha (letras/palavras/pontuação contíguas)
  // numa única unidade editável — evita sobras (ex.: o ponto final de uma
  // frase que o PDF.js reporta como item separado).
  function mergeTextRuns(items) {
    const runs = [];
    let cur = null;
    for (const it of items) {
      if (!it.str) continue;
      const m = it.transform;
      const angle = Math.atan2(m[1], m[0]);
      if (cur) {
        const gap = m[4] - cur.end;
        const sameLine = Math.abs(m[5] - cur.f) < 2.5 && Math.abs(angle - cur.angle) < 0.05;
        if (sameLine && gap > -1 && gap < 3.5) {
          cur.str += it.str;
          cur.end = m[4] + (it.width || 0);
          cur.width = cur.end - cur.x;
          continue;
        }
      }
      cur = {
        str: it.str,
        transform: [m[0], m[1], m[2], m[3], m[4], m[5]],
        width: it.width || 0,
        fontName: it.fontName,
        x: m[4], f: m[5], angle,
        end: m[4] + (it.width || 0),
      };
      runs.push(cur);
    }
    return runs;
  }

  async function getTextItems(srcIndex) {
    if (state.textCache.has(srcIndex)) return state.textCache.get(srcIndex);
    const page = await state.doc.getPage(srcIndex + 1);
    const tc = await page.getTextContent();
    const data = { items: mergeTextRuns(tc.items), styles: tc.styles };
    state.textCache.set(srcIndex, data);
    return data;
  }

  async function renderTextLayer() {
    const layer = els.textLayer;
    layer.replaceChildren();
    layer.classList.toggle('active', state.editMode);
    if (!state.editMode) return;
    const p = getActive();
    if (!p || !state.doc) return;

    const token = ++textLayerToken;
    const page = await state.doc.getPage(p.srcIndex + 1);
    const rot = mod(p.baseRotation + p.rotation, 360);
    const viewport = page.getViewport({ scale: state.scale, rotation: rot });
    const { items, styles } = await getTextItems(p.srcIndex);
    if (token !== textLayerToken) return;

    const edits = state.edits.get(p.id);
    let editable = 0;

    items.forEach((item, i) => {
      if (!item.str || !item.str.trim()) return;
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]);
      if (!fontHeight) return;
      editable++;
      const angle = Math.atan2(tx[1], tx[0]);
      const st = styles[item.fontName];
      const ascent = (st && st.ascent) || 0.8;
      const ed = edits ? edits.get(i) : null;

      const span = document.createElement('div');
      span.className = 'text-span' + (ed && ed.text !== item.str ? ' edited' : '');
      span.dataset.idx = i;
      span.textContent = ed ? ed.text : item.str;
      span.style.left = tx[4] + 'px';
      span.style.top = (tx[5] - fontHeight * ascent) + 'px';
      span.style.fontSize = fontHeight + 'px';
      span.style.width = Math.max(2, item.width * state.scale) + 'px';
      if (angle) span.style.transform = 'rotate(' + angle + 'rad)';
      if (ed) { span.style.color = ed.color; span.title = 'Toque para editar novamente'; }

      span.addEventListener('click', ev => beginSpanEdit(ev, span, i));
      span.addEventListener('blur', () => commitSpanEdit(span, item, i));
      span.addEventListener('keydown', ev => {
        ev.stopPropagation();
        if (ev.key === 'Enter') { ev.preventDefault(); span.blur(); }
      });
      layer.appendChild(span);
    });

    if (!editable && state.editMode) {
      toast('Esta página não tem texto selecionável (pode ser imagem/scanned).');
    }
  }

  function beginSpanEdit(ev, span, i) {
    ev.stopPropagation();
    state.editSel = i;
    if (span.isContentEditable) return;
    span.contentEditable = 'true';
    span.classList.add('editing');
    span.focus();
    const r = document.createRange();
    r.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function commitSpanEdit(span, item, i) {
    span.contentEditable = 'false';
    span.classList.remove('editing');
    const p = getActive();
    if (!p) return;
    const text = span.textContent.replace(/[\s\u00A0]+$/, '');
    if (!state.edits.get(p.id)) state.edits.set(p.id, new Map());
    const em = state.edits.get(p.id);
    const prev = em.get(i);
    if (text === item.str) {
      em.delete(i);                       // voltou ao original → remove a edição
    } else {
      em.set(i, { text, color: (prev && prev.color) || state.editDefaultColor });
    }
    renderTextLayer();
  }

  // caracteres que a fonte padrão (WinAnsi) não suporta viram "?"
  const sanitizeWinAnsi = t => t.replace(
    /[^\u0000-\u00FF\u20AC\u2018\u2019\u201C\u201D\u2013\u2014\u02DC\u2122]/g, '?');

  function drawEditedText(page, item, ed, font) {
    const m = item.transform;
    const ex = m[4], ey = m[5];
    const fontH = Math.hypot(m[2], m[3]) || 12;
    const angleDeg = Math.atan2(m[1], m[0]) * 180 / Math.PI;
    const w = item.width || 0;

    // 1) apaga o texto original com um retângulo branco na área exata
    //    (com uma folga extra para cobrir variações de métrica da fonte)
    if (w > 0) {
      page.drawRectangle({
        x: ex - 0.75, y: ey - 1.5,
        width: w + 2.5, height: fontH + 3.5,
        color: rgb(1, 1, 1),
        rotate: degrees(angleDeg),
      });
    }
    if (!ed.text) return;                 // texto vazio = só apagar

    // 2) reescreve, encolhendo se não couber na largura original
    const text = sanitizeWinAnsi(ed.text);
    let size = fontH;
    try {
      const tw = font.widthOfTextAtSize(text, size);
      if (w > 0 && tw > w) size = Math.max(4, size * (w / tw) * 0.98);
    } catch (_) { /* ignora métricas */ }
    page.drawText(text, {
      x: ex, y: ey,
      size, font,
      color: hexToRgb(ed.color || '#111827'),
      rotate: degrees(angleDeg),
    });
  }

  /* ---------------- exportação ---------------- */
  function visualPointToMedia(T, mb, vx, vy) {
    const W = mb.width, H = mb.height;
    let x, y;
    switch (T) {
      case 90:  x = vy;        y = vx;      break;
      case 180: x = W - vx;    y = vy;      break;
      case 270: x = W - vy;    y = H - vx;  break;
      default:  x = vx;        y = H - vy;  break;
    }
    return { x: mb.x + x, y: mb.y + y };
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
    if (!m) return rgb(0, 0, 0);
    const n = parseInt(m[1], 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }

  function wrapText(font, text, size, maxWidth) {
    const lines = [];
    text.split('\n').forEach(par => {
      const words = par.split(/\s+/).filter(w => w.length);
      if (!words.length) { lines.push(''); return; }
      let cur = '';
      words.forEach(word => {
        const test = cur ? cur + ' ' + word : word;
        if (!cur || font.widthOfTextAtSize(test, size) <= maxWidth) cur = test;
        else { lines.push(cur); cur = word; }
      });
      lines.push(cur);
    });
    return lines;
  }

  function dataUrlToBytes(dataUrl) {
    const b64 = dataUrl.split(',')[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  async function drawElement(doc, page, el, T, mb, font, fontBold, imgCache) {
    if (el.type === 'text') {
      const size = el.fontSize;
      const f = el.bold ? fontBold : font;
      const lines = wrapText(f, el.text, size, el.w);
      const anchor = visualPointToMedia(T, mb, el.x, el.y + el.h - size * 0.22);
      page.drawText(lines.join('\n'), {
        x: anchor.x, y: anchor.y,
        size, font: f,
        color: hexToRgb(el.color),
        rotate: degrees(T),
        lineHeight: size * 1.3,
      });
    } else {
      let img = imgCache.get(el.dataUrl);
      if (!img) {
        img = el.mime === 'jpg'
          ? await doc.embedJpg(dataUrlToBytes(el.dataUrl))
          : await doc.embedPng(dataUrlToBytes(el.dataUrl));
        imgCache.set(el.dataUrl, img);
      }
      const anchor = visualPointToMedia(T, mb, el.x, el.y + el.h);
      page.drawImage(img, {
        x: anchor.x, y: anchor.y,
        width: el.w, height: el.h,
        rotate: degrees(T),
      });
    }
  }

  async function exportPdf() {
    if (!requireDoc() || !state.pages.length) return;
    setBusy(true, 'Aplicando páginas, textos e assinaturas...');
    try {
      const src = await PDFDocument.load(state.pdfBytes.slice(0));
      const out = await PDFDocument.create();

      const copied = await out.copyPages(src, state.pages.map(p => p.srcIndex));
      const font = await out.embedFont(StandardFonts.Helvetica);
      const fontBold = await out.embedFont(StandardFonts.HelveticaBold);
      const imgCache = new Map();

      for (let i = 0; i < state.pages.length; i++) {
        const p = state.pages[i];
        const page = copied[i];
        const T = mod(p.baseRotation + p.rotation, 360);
        page.setRotation(degrees(T));
        const mb = page.getMediaBox();
        // 1) edições de texto existente (apaga + reescreve)
        const em = state.edits.get(p.id);
        if (em && em.size) {
          const tc = await getTextItems(p.srcIndex);
          for (const [idx, ed] of em) {
            const item = tc.items[idx];
            if (item) drawEditedText(page, item, ed, font);
          }
        }
        // 2) elementos sobrepostos (caixas de texto novas e assinaturas)
        for (const el of (state.elements.get(p.id) || [])) {
          await drawElement(out, page, el, T, mb, font, fontBold, imgCache);
        }
        out.addPage(page);
      }

      const bytes = await out.save();
      downloadBytes(bytes, (state.fileName || 'documento').replace(/\.pdf$/i, '') + '-editado.pdf');
      toast('PDF exportado com sucesso!');
    } catch (err) {
      console.error(err);
      toast('Erro ao exportar: ' + (err && err.message ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  function downloadBytes(bytes, name) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* ---------------- start ---------------- */
  init();
})();
