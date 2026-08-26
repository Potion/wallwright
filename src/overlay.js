// Overlay renderer. Three modes, all driven by state pushed from the main
// process:
//   grid   - invisible hotspots, one per panel, that promote on click
//   active - just the corner Back button
//   edit   - draggable panel frames with move / resize / scale handles
//
// Everything here works in window pixels. Wall units only appear as readout
// text, echoed back from the main process after it converts.

const root = document.getElementById('root');

let current = { mode: 'grid' };
const readouts = new Map(); // view id -> readout element
const panels = new Map(); // view id -> panel element
let guideLayer = null;
let bandEl = null; // rubber band while drawing a new panel
let selectedId = null;

window.wallwright.onState((s) => {
  current = s;
  if (s.mode !== 'edit') namingPreset = false;
  render();
});

window.wallwright.onLayoutEcho(({ id, grid, zoom }) => {
  const el = readouts.get(id);
  if (el) el.textContent = fmt(grid, zoom);
});

window.wallwright.onSelect((id) => {
  selectedId = id;
  render();
  // A panel that was just created has no URL, so put the caret where the work
  // is instead of making someone hunt for the field.
  const url = document.getElementById('insp-url');
  if (url && !url.value) url.focus();
});

// True when a text field has focus, so the editor's own key handling does not
// swallow typing. Esc and Cmd+F both mean something different mid-edit.
function typing() {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable);
}

function fmt(grid, zoom) {
  return `${grid.width} x ${grid.height}  at ${grid.x},${grid.y}  zoom ${zoom}`;
}

function render() {
  root.innerHTML = '';
  readouts.clear();
  panels.clear();
  guideLayer = null;
  document.body.className = current.mode + (current.hint ? ' hint' : '');

  if (current.mode === 'grid' || current.mode === 'select') return renderGrid();
  if (current.mode === 'edit') return renderEdit();
  return renderActive();
}

// ---- grid -------------------------------------------------------------------

function renderGrid() {
  if (current.mode === 'select') {
    const bar = document.createElement('div');
    bar.className = 'editbar';
    bar.innerHTML =
      '<strong>Open a panel</strong> click one to fill the wall &middot; ' +
      '<kbd>Esc</kbd> cancel';
    root.appendChild(bar);
  }

  current.views.forEach((v) => {
    const hs = document.createElement('button');
    hs.className = 'hotspot';
    place(hs, v.grid);
    hs.setAttribute('aria-label', 'Activate ' + (v.label || v.id));
    hs.addEventListener('click', () => window.wallwright.activate(v.id));
    root.appendChild(hs);
  });
}

// ---- active -----------------------------------------------------------------

function renderActive() {
  const back = document.createElement('button');
  back.className = 'back';
  back.textContent = 'Back to grid';
  back.addEventListener('click', () => window.wallwright.back());
  root.appendChild(back);
}

// ---- edit -------------------------------------------------------------------

// Corners scale (aspect locked, content scales with the frame). Sides resize one
// axis (the page reflows). The body moves.
const CORNERS = ['nw', 'ne', 'se', 'sw'];
const SIDES = ['n', 'e', 's', 'w'];

// How close an edge has to get before it snaps, in window pixels. A pixel
// threshold rather than a wall-unit one, because it should feel the same to the
// hand whether the wall is being previewed small or driven 1:1.
const SNAP = 10;

// The mark: the app icon's montage, one hero panel and three around it. Kept as
// markup rather than an image file so it inherits the palette and ships with no
// asset.
//
// The icon carries the editor's corner grips on the hero panel; this size does
// not. At 20px four white squares read as dirt on the glass rather than as
// handles, and the montage silhouette is what has to survive. See
// docs/identity.md.
const MARK = `
  <svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="14.7" y="2" width="7.3" height="11.5" fill="var(--accent)" opacity="0.4"/>
    <rect x="2" y="14.7" width="5.2" height="7.3" fill="var(--accent)" opacity="0.4"/>
    <rect x="8.4" y="14.7" width="13.6" height="7.3" fill="var(--accent)" opacity="0.4"/>
    <rect x="2" y="2" width="11.5" height="11.5" fill="var(--accent)"/>
  </svg>`;

function renderBrand() {
  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.innerHTML = MARK + '<span class="brand-name">Wallwright</span>';
  return brand;
}

function renderEdit() {
  // Drop the selection if the panel it pointed at is gone.
  if (selectedId && !current.views.some((v) => v.id === selectedId)) selectedId = null;

  const bar = document.createElement('div');
  bar.className = 'editbar';
  const add = document.createElement('button');
  add.className = 'addbtn';
  add.textContent = '+ Add panel';
  add.addEventListener('click', () => {
    // Drop it somewhere visible and let it be moved; drawing on empty wall is
    // the other way in.
    const st = current.stage;
    const w = Math.round(st.width / 3);
    const h = Math.round(st.height / 3);
    window.wallwright.addPanel({
      x: Math.round(st.x + (st.width - w) / 2),
      y: Math.round(st.y + (st.height - h) / 2),
      width: w,
      height: h,
    });
  });
  bar.appendChild(renderPresets());

  const hint = document.createElement('span');
  hint.className = 'barhint';
  hint.innerHTML =
    'drag to move &middot; sides resize &middot; corners scale &middot; ' +
    'drag empty wall to add &middot; <kbd>Alt</kbd> no snap &middot; ' +
    '<kbd>Del</kbd> remove &middot; <kbd>Esc</kbd> save &middot; ' +
    '<kbd>Shift</kbd>+<kbd>Esc</kbd> discard';
  const title = document.createElement('strong');
  title.textContent = 'Layout edit';
  bar.prepend(renderBrand());
  bar.append(title, add, hint);
  bar.addEventListener('pointerdown', (e) => e.stopPropagation());
  root.appendChild(bar);

  bandEl = document.createElement('div');
  bandEl.className = 'band';
  bandEl.style.display = 'none';
  root.appendChild(bandEl);

  guideLayer = document.createElement('div');
  guideLayer.className = 'guides';
  root.appendChild(guideLayer);

  current.views.forEach((v) => {
    const panel = document.createElement('div');
    panel.className = 'epanel' + (v.id === selectedId ? ' selected' : '');
    place(panel, v.grid);
    panels.set(v.id, panel);

    const label = document.createElement('div');
    label.className = 'elabel';
    const name = document.createElement('span');
    name.className = 'ename';
    name.textContent = v.label || v.id;
    name.textContent = v.label || v.url || v.id;
    const read = document.createElement('span');
    read.className = 'eread';
    read.textContent = fmt(v.wallGrid, v.zoom);
    readouts.set(v.id, read);
    label.append(name, read);
    panel.appendChild(label);

    // The body selects, and moves if the pointer goes anywhere.
    panel.addEventListener('pointerdown', (e) => {
      if (e.target !== panel && e.target !== label && e.target.parentElement !== label) return;
      if (selectedId !== v.id) {
        selectedId = v.id;
        renderInspector();
        panels.forEach((el, id) => el.classList.toggle('selected', id === selectedId));
      }
      startDrag(e, v, panel, 'move');
    });

    [...CORNERS, ...SIDES].forEach((h) => {
      const grip = document.createElement('div');
      grip.className = 'grip grip-' + h;
      grip.addEventListener('pointerdown', (e) => startDrag(e, v, panel, h));
      panel.appendChild(grip);
    });

    root.appendChild(panel);
  });

  renderInspector();
}

// ---- presets ----------------------------------------------------------------
//
// Named montages. A chip per preset, plus a way to save the current one. No
// window.prompt: a modal dialog blocks the whole renderer, and on a wall with no
// window chrome there is no good way out of one.

let namingPreset = false;

function renderPresets() {
  const wrap = document.createElement('span');
  wrap.className = 'presets';

  if (namingPreset) {
    const input = document.createElement('input');
    input.className = 'preset-name';
    input.placeholder = 'Name this montage';
    input.spellcheck = false;
    const commit = () => {
      const name = input.value.trim();
      namingPreset = false;
      if (name) window.wallwright.savePreset(name);
      else render();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') {
        namingPreset = false;
        render();
      }
    });
    input.addEventListener('blur', commit);
    wrap.appendChild(input);
    // Focus after it is in the document.
    setTimeout(() => input.focus(), 0);
    return wrap;
  }

  const label = document.createElement('span');
  label.className = 'preset-label';
  label.textContent = current.presets.length ? 'Montages' : 'No saved montages';
  wrap.appendChild(label);

  current.presets.forEach((p, i) => {
    const chip = document.createElement('span');
    chip.className = 'preset' + (p.id === current.activePresetId ? ' active' : '');

    const use = document.createElement('button');
    use.className = 'preset-use';
    // The number is the shortcut that recalls it without opening the editor.
    use.textContent = i < 9 ? `${i + 1}. ${p.name}` : p.name;
    use.title = i < 9 ? `Recall with Ctrl/Cmd+Shift+${i + 1}` : 'Recall';
    use.addEventListener('click', () => window.wallwright.applyPreset(p.id));

    const del = document.createElement('button');
    del.className = 'preset-del';
    del.textContent = '\u00d7';
    del.title = `Delete "${p.name}"`;
    del.addEventListener('click', () => window.wallwright.deletePreset(p.id));

    chip.append(use, del);
    wrap.appendChild(chip);
  });

  const save = document.createElement('button');
  save.className = 'preset-save';
  save.textContent = '+ Save as montage';
  save.title = 'Save the current layout and URLs under a name';
  save.addEventListener('click', () => {
    namingPreset = true;
    render();
  });
  wrap.appendChild(save);

  return wrap;
}

// ---- inspector --------------------------------------------------------------

function renderInspector() {
  const existing = document.getElementById('inspector');
  if (existing) existing.remove();
  if (current.mode !== 'edit') return;

  const v = current.views.find((x) => x.id === selectedId);
  const box = document.createElement('div');
  box.id = 'inspector';
  box.className = 'inspector';

  if (!v) {
    box.innerHTML =
      '<div class="insp-empty">No panel selected.<br />Click a panel to edit it, ' +
      'or drag on empty wall to add one.</div>';
    root.appendChild(box);
    return;
  }

  const commit = (patch) => window.wallwright.updatePanel(v.id, patch);

  const field = (labelText, el) => {
    const wrap = document.createElement('label');
    wrap.className = 'insp-field';
    const t = document.createElement('span');
    t.textContent = labelText;
    wrap.append(t, el);
    return wrap;
  };

  const head = document.createElement('div');
  head.className = 'insp-head';
  head.textContent = v.id;

  const url = document.createElement('input');
  url.id = 'insp-url';
  url.type = 'text';
  url.value = v.url || '';
  url.placeholder = 'https://...';
  url.spellcheck = false;
  // On change, not on input: every commit re-renders, which would steal focus
  // after each keystroke.
  url.addEventListener('change', () => commit({ url: url.value.trim() }));
  url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') url.blur();
  });

  const label = document.createElement('input');
  label.type = 'text';
  label.value = v.label || '';
  label.placeholder = '(optional)';
  label.addEventListener('change', () => commit({ label: label.value }));

  const zoom = document.createElement('input');
  zoom.type = 'number';
  zoom.step = '0.05';
  zoom.min = '0.1';
  zoom.value = String(v.zoom);
  zoom.addEventListener('change', () => {
    const n = parseFloat(zoom.value);
    if (Number.isFinite(n) && n > 0) commit({ zoom: n });
  });

  const session = document.createElement('select');
  const own = document.createElement('option');
  own.value = 'persist:' + v.id;
  own.textContent = 'Its own session';
  session.appendChild(own);
  current.views
    .filter((o) => o.id !== v.id)
    .forEach((o) => {
      const opt = document.createElement('option');
      opt.value = o.partition;
      opt.textContent = `Share with ${o.label || o.id}`;
      session.appendChild(opt);
    });
  session.value = v.partition;
  if (session.value !== v.partition) {
    // Its partition is not one of the offered options, so show it as-is.
    const opt = document.createElement('option');
    opt.value = v.partition;
    opt.textContent = v.partition;
    session.appendChild(opt);
    session.value = v.partition;
  }
  session.addEventListener('change', () => commit({ partition: session.value }));

  const note = document.createElement('div');
  note.className = 'insp-note';
  note.textContent = v.sharedWith.length
    ? 'Shares a login with ' + v.sharedWith.join(', ')
    : 'Its login is independent of the other panels.';

  const open = document.createElement('button');
  open.className = 'insp-open';
  open.textContent = 'Open fullscreen';
  open.addEventListener('click', () => window.wallwright.promote(v.id));

  const del = document.createElement('button');
  del.className = 'insp-del';
  del.textContent = 'Delete panel';
  del.addEventListener('click', () => {
    selectedId = null;
    window.wallwright.deletePanel(v.id);
  });

  box.append(
    head,
    field('URL', url),
    field('Label', label),
    field('Zoom', zoom),
    field('Session', session),
    note,
    open,
    del
  );
  root.appendChild(box);
}

// ---- snapping ---------------------------------------------------------------
//
// The geometry itself lives in src/layout.js, which this page loads as a plain
// script before overlay.js. It used to be implemented twice - once there in wall
// units, once here in window pixels - and the two had already drifted apart. What
// is left here is only the part that is genuinely renderer-specific: reading the
// candidate edges out of the DOM.
const L = window.WallwrightLayout;

// Edges worth snapping to: the wall's own edges and centre lines, plus the live
// edges of every other panel. Read from the DOM rather than from state, because
// other panels may already have been moved earlier in this edit session.
//
// Not rounded, unlike the wall-units version: these are fractional window pixels
// and rounding them would put the guide a fraction off the edge it is marking.
function snapTargets(exceptId) {
  const st = current.stage;
  const xs = [st.x, st.x + st.width / 2, st.x + st.width];
  const ys = [st.y, st.y + st.height / 2, st.y + st.height];
  panels.forEach((el, id) => {
    if (id === exceptId) return;
    xs.push(el.offsetLeft, el.offsetLeft + el.offsetWidth);
    ys.push(el.offsetTop, el.offsetTop + el.offsetHeight);
  });
  return { xs, ys };
}

// Snap a drag. Mutates r in place and returns the guides, which is the shape the
// drag loop below wants; layout.js itself is non-mutating.
function applySnap(r, kind, handle, base, aspect, exceptId) {
  const { xs, ys } = snapTargets(exceptId);
  const { rect, guides } = L.snapRect(r, {
    kind,
    handle,
    base,
    aspect,
    xs,
    ys,
    tolerance: SNAP,
  });
  Object.assign(r, rect);
  return guides;
}

// Snap a rectangle being drawn on empty wall, so a new panel lands flush with its
// neighbours. Same in-place contract as applySnap.
function snapCreate(r) {
  const { xs, ys } = snapTargets(null);
  const { rect, guides } = L.snapDrawnRect(r, { xs, ys, tolerance: SNAP });
  Object.assign(r, rect);
  return guides;
}

function drawGuides(guides) {
  if (!guideLayer) return;
  guideLayer.innerHTML = '';
  const st = current.stage;
  guides.x.forEach((x) => {
    const el = document.createElement('div');
    el.className = 'guide guide-v';
    el.style.left = x + 'px';
    el.style.top = st.y + 'px';
    el.style.height = st.height + 'px';
    guideLayer.appendChild(el);
  });
  guides.y.forEach((y) => {
    const el = document.createElement('div');
    el.className = 'guide guide-h';
    el.style.top = y + 'px';
    el.style.left = st.x + 'px';
    el.style.width = st.width + 'px';
    guideLayer.appendChild(el);
  });
}

// ---- creating by drawing ----------------------------------------------------

function startCreate(e) {
  const ax = e.clientX;
  const ay = e.clientY;
  let rect = null;

  const onMove = (ev) => {
    // Normalised, so dragging up and to the left works.
    const r = L.normaliseRect(ax, ay, ev.clientX, ev.clientY);
    const guides = ev.altKey ? { x: [], y: [] } : snapCreate(r);
    drawGuides(guides);
    bandEl.style.display = 'block';
    place(bandEl, { x: r.x, y: r.y, width: r.w, height: r.h });
    rect = r;
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    bandEl.style.display = 'none';
    drawGuides({ x: [], y: [] });

    // Too small to be a panel: treat it as a click on empty wall, which just
    // clears the selection.
    if (!rect || rect.w < current.minPx || rect.h < current.minPx) {
      if (selectedId !== null) {
        selectedId = null;
        render();
      }
      return;
    }
    window.wallwright.addPanel({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.w),
      height: Math.round(rect.h),
    });
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// ---- dragging ---------------------------------------------------------------

function startDrag(e, view, panel, handle) {
  e.preventDefault();
  e.stopPropagation();

  const { kind, axis, east, south } = L.parseHandle(handle);
  const startX = e.clientX;
  const startY = e.clientY;
  const base = {
    x: panel.offsetLeft,
    y: panel.offsetTop,
    w: panel.offsetWidth,
    h: panel.offsetHeight,
  };
  const aspect = base.w / base.h;

  panel.classList.add('dragging');
  window.wallwright.dragStart(view.id);

  let pending = null;
  let frame = 0;

  const flush = () => {
    frame = 0;
    if (!pending) return;
    window.wallwright.layout({
      id: view.id,
      kind,
      // Which edge the gesture drives, so the main process can leave the other
      // dimensions exactly as they were instead of round-tripping them through
      // pixels, and can re-snap the driven edge in wall units.
      handle,
      axis,
      rect: {
        x: Math.round(pending.x),
        y: Math.round(pending.y),
        width: Math.round(pending.w),
        height: Math.round(pending.h),
      },
    });
    pending = null;
  };

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const r = { ...base };

    if (kind === 'move') {
      r.x = base.x + dx;
      r.y = base.y + dy;
    } else if (kind === 'resize') {
      if (handle === 'e') r.w = base.w + dx;
      if (handle === 'w') {
        r.w = base.w - dx;
        r.x = base.x + dx;
      }
      if (handle === 's') r.h = base.h + dy;
      if (handle === 'n') {
        r.h = base.h - dy;
        r.y = base.y + dy;
      }
    } else {
      // Aspect-locked, anchored on the opposite corner. Drive from whichever
      // axis the pointer moved further along so diagonal drags feel direct.
      const sx = east ? 1 : -1;
      const sy = south ? 1 : -1;
      const w = Math.max(base.w + sx * dx, (base.h + sy * dy) * aspect);
      r.w = w;
      r.h = w / aspect;
      if (!east) r.x = base.x + (base.w - r.w);
      if (!south) r.y = base.y + (base.h - r.h);
    }

    // Alt defeats snapping, for the case where a panel genuinely belongs a few
    // pixels off an edge.
    const guides = ev.altKey
      ? { x: [], y: [] }
      : applySnap(r, kind, handle, base, aspect, view.id);

    clamp(r, kind, aspect);
    drawGuides(guides);
    place(panel, { x: r.x, y: r.y, width: r.w, height: r.h });
    pending = r;
    if (!frame) frame = window.requestAnimationFrame(flush);
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (frame) window.cancelAnimationFrame(frame);
    flush();
    drawGuides({ x: [], y: [] });
    panel.classList.remove('dragging');
    window.wallwright.dragEnd();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// Keep the panel inside the wall area and above the minimum size. A scale drag
// shrinks proportionally rather than clipping one axis, so the aspect lock holds
// even at the edges. The stage has an origin as well as a size here, because it is
// letterboxed inside the window rather than starting at 0,0.
function clamp(r, kind, aspect) {
  const st = current.stage;
  Object.assign(
    r,
    L.clampRect(r, {
      kind,
      aspect,
      bounds: { x: st.x, y: st.y, width: st.width, height: st.height },
      min: current.minPx,
    })
  );
  return r;
}

// ---- shared -----------------------------------------------------------------

function place(el, rect) {
  el.style.left = rect.x + 'px';
  el.style.top = rect.y + 'px';
  el.style.width = rect.width + 'px';
  el.style.height = rect.height + 'px';
}

// Anything that reaches the root in edit mode is empty wall: panels and the
// toolbar stop their own events.
root.addEventListener('pointerdown', (e) => {
  if (current.mode !== 'edit') return;
  if (e.target !== root) return;
  e.preventDefault();
  startCreate(e);
});

// Report activity while the pointer is over the overlay. In active mode that is
// only the Back-button corner; the pages report their own activity through
// content-preload.js.
['mousemove', 'mousedown', 'keydown', 'wheel'].forEach((ev) =>
  window.addEventListener(ev, () => window.wallwright.activity(), {
    passive: true,
    capture: true,
  })
);

window.addEventListener('keydown', (e) => {
  // While a field has focus, Esc means "leave this field" and Cmd+F means
  // nothing. Exiting the whole editor mid-sentence would be hostile.
  if (typing()) {
    if (e.key === 'Escape') {
      e.preventDefault();
      document.activeElement.blur();
    }
    return;
  }

  // The overlay holds focus in grid and edit modes, so the fullscreen toggle
  // has to be handled here too, not just in the content views.
  if (e.key.toLowerCase() === 'f' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    window.wallwright.toggleFullscreen();
    return;
  }

  if (current.mode === 'edit' && (e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
    e.preventDefault();
    const id = selectedId;
    selectedId = null;
    window.wallwright.deletePanel(id);
    return;
  }

  if (e.key !== 'Escape') return;
  if (current.mode === 'edit') window.wallwright.editExit({ discard: e.shiftKey });
  // Not back(): the single/double/off policy lives in the main process, so the
  // overlay reports the keypress rather than deciding what it means. Select
  // mode goes through the same route, where Esc cancels without promoting.
  else if (current.mode === 'active' || current.mode === 'select') window.wallwright.escape();
});
