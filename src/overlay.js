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

window.forge.onState((s) => {
  current = s;
  render();
});

window.forge.onLayoutEcho(({ id, grid, zoom }) => {
  const el = readouts.get(id);
  if (el) el.textContent = fmt(grid, zoom);
});

window.forge.onSelect((id) => {
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
    hs.addEventListener('click', () => window.forge.activate(v.id));
    root.appendChild(hs);
  });
}

// ---- active -----------------------------------------------------------------

function renderActive() {
  const back = document.createElement('button');
  back.className = 'back';
  back.textContent = 'Back to grid';
  back.addEventListener('click', () => window.forge.back());
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
    window.forge.addPanel({
      x: Math.round(st.x + (st.width - w) / 2),
      y: Math.round(st.y + (st.height - h) / 2),
      width: w,
      height: h,
    });
  });
  const hint = document.createElement('span');
  hint.className = 'barhint';
  hint.innerHTML =
    'drag to move &middot; sides resize &middot; corners scale &middot; ' +
    'drag empty wall to add &middot; <kbd>Alt</kbd> no snap &middot; ' +
    '<kbd>Del</kbd> remove &middot; <kbd>Esc</kbd> save &middot; ' +
    '<kbd>Shift</kbd>+<kbd>Esc</kbd> discard';
  const title = document.createElement('strong');
  title.textContent = 'Layout edit';
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

  const commit = (patch) => window.forge.updatePanel(v.id, patch);

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
  open.addEventListener('click', () => window.forge.promote(v.id));

  const del = document.createElement('button');
  del.className = 'insp-del';
  del.textContent = 'Delete panel';
  del.addEventListener('click', () => {
    selectedId = null;
    window.forge.deletePanel(v.id);
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

// Edges worth snapping to: the wall's own edges and centre lines, plus the live
// edges of every other panel. Read from the DOM rather than from state, because
// other panels may already have been moved earlier in this edit session.
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

function nearest(value, targets) {
  let best = null;
  let bestDelta = SNAP + 1;
  for (const t of targets) {
    const d = Math.abs(t - value);
    if (d < bestDelta) {
      bestDelta = d;
      best = t;
    }
  }
  return best === null ? null : { target: best, delta: best - value };
}

// Of several candidate edges on one axis, take whichever is closest to a target.
function nearestEdge(values, targets) {
  let best = null;
  for (const v of values) {
    const hit = nearest(v, targets);
    if (hit && (!best || Math.abs(hit.delta) < Math.abs(best.delta))) best = hit;
  }
  return best;
}

// Adjusts r in place and returns the guide lines to draw.
function applySnap(r, kind, handle, base, aspect, exceptId) {
  const { xs, ys } = snapTargets(exceptId);
  const guides = { x: [], y: [] };

  if (kind === 'move') {
    const sx = nearestEdge([r.x, r.x + r.w / 2, r.x + r.w], xs);
    if (sx) {
      r.x += sx.delta;
      guides.x.push(sx.target);
    }
    const sy = nearestEdge([r.y, r.y + r.h / 2, r.y + r.h], ys);
    if (sy) {
      r.y += sy.delta;
      guides.y.push(sy.target);
    }
    return guides;
  }

  if (kind === 'resize') {
    // Only the dragged edge snaps; the opposite edge stays pinned where the
    // drag started.
    if (handle === 'e') {
      const s = nearest(r.x + r.w, xs);
      if (s) {
        r.w = s.target - base.x;
        guides.x.push(s.target);
      }
    } else if (handle === 'w') {
      const s = nearest(r.x, xs);
      if (s) {
        r.x = s.target;
        r.w = base.x + base.w - s.target;
        guides.x.push(s.target);
      }
    } else if (handle === 's') {
      const s = nearest(r.y + r.h, ys);
      if (s) {
        r.h = s.target - base.y;
        guides.y.push(s.target);
      }
    } else if (handle === 'n') {
      const s = nearest(r.y, ys);
      if (s) {
        r.y = s.target;
        r.h = base.y + base.h - s.target;
        guides.y.push(s.target);
      }
    }
    return guides;
  }

  // Scale: aspect is locked, so snapping one edge decides both dimensions. Take
  // whichever of the two moving edges is closer to a target.
  const east = handle.includes('e');
  const south = handle.includes('s');
  const sx = nearest(east ? r.x + r.w : r.x, xs);
  const sy = nearest(south ? r.y + r.h : r.y, ys);
  const useX = sx && (!sy || Math.abs(sx.delta) <= Math.abs(sy.delta));

  if (useX) {
    r.w = east ? sx.target - base.x : base.x + base.w - sx.target;
    r.h = r.w / aspect;
    guides.x.push(sx.target);
  } else if (sy) {
    r.h = south ? sy.target - base.y : base.y + base.h - sy.target;
    r.w = r.h * aspect;
    guides.y.push(sy.target);
  } else {
    return guides;
  }
  // Re-anchor on the opposite corner, the same way the drag itself does.
  r.x = east ? base.x : base.x + base.w - r.w;
  r.y = south ? base.y : base.y + base.h - r.h;
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

// Drag on empty wall to draw a new panel. Snapping applies to the rectangle
// being drawn, so a new panel lands flush with its neighbours.
function snapCreate(r) {
  const { xs, ys } = snapTargets(null);
  const guides = { x: [], y: [] };
  const left = nearest(r.x, xs);
  if (left) {
    const right = r.x + r.w;
    r.x = left.target;
    r.w = right - r.x;
    guides.x.push(left.target);
  }
  const right = nearest(r.x + r.w, xs);
  if (right) {
    r.w = right.target - r.x;
    guides.x.push(right.target);
  }
  const top = nearest(r.y, ys);
  if (top) {
    const bottom = r.y + r.h;
    r.y = top.target;
    r.h = bottom - r.y;
    guides.y.push(top.target);
  }
  const bottom = nearest(r.y + r.h, ys);
  if (bottom) {
    r.h = bottom.target - r.y;
    guides.y.push(bottom.target);
  }
  return guides;
}

function startCreate(e) {
  const ax = e.clientX;
  const ay = e.clientY;
  let rect = null;

  const onMove = (ev) => {
    // Normalise, so dragging up and to the left works.
    const r = {
      x: Math.min(ax, ev.clientX),
      y: Math.min(ay, ev.clientY),
      w: Math.abs(ev.clientX - ax),
      h: Math.abs(ev.clientY - ay),
    };
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
    window.forge.addPanel({
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

  const kind = handle === 'move' ? 'move' : handle.length === 2 ? 'scale' : 'resize';
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
  window.forge.dragStart(view.id);

  let pending = null;
  let frame = 0;

  const flush = () => {
    frame = 0;
    if (!pending) return;
    window.forge.layout({
      id: view.id,
      kind,
      // Which edge the gesture drives, so the main process can leave the other
      // dimensions exactly as they were instead of round-tripping them through
      // pixels, and can re-snap the driven edge in wall units.
      handle,
      axis:
        handle === 'e' || handle === 'w' ? 'x' : handle === 'n' || handle === 's' ? 'y' : null,
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
      const sx = handle.includes('e') ? 1 : -1;
      const sy = handle.includes('s') ? 1 : -1;
      const w = Math.max(base.w + sx * dx, (base.h + sy * dy) * aspect);
      r.w = w;
      r.h = w / aspect;
      if (handle.includes('w')) r.x = base.x + (base.w - r.w);
      if (handle.includes('n')) r.y = base.y + (base.h - r.h);
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
    window.forge.dragEnd();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// Keep the panel inside the wall area and above the minimum size. A scale drag
// shrinks proportionally rather than clipping one axis, so the aspect lock holds
// even at the edges.
function clamp(r, kind, aspect) {
  const st = current.stage;
  const min = current.minPx;

  if (kind === 'scale') {
    if (r.w < min) {
      r.w = min;
      r.h = min / aspect;
    }
    const k = Math.min(1, st.width / r.w, st.height / r.h);
    r.w *= k;
    r.h *= k;
  } else {
    r.w = Math.min(Math.max(r.w, min), st.width);
    r.h = Math.min(Math.max(r.h, min), st.height);
  }

  r.x = Math.min(Math.max(r.x, st.x), st.x + st.width - r.w);
  r.y = Math.min(Math.max(r.y, st.y), st.y + st.height - r.h);
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
  window.addEventListener(ev, () => window.forge.activity(), { passive: true, capture: true })
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
    window.forge.toggleFullscreen();
    return;
  }

  if (current.mode === 'edit' && (e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
    e.preventDefault();
    const id = selectedId;
    selectedId = null;
    window.forge.deletePanel(id);
    return;
  }

  if (e.key !== 'Escape') return;
  if (current.mode === 'edit') window.forge.editExit({ discard: e.shiftKey });
  // Not back(): the single/double/off policy lives in the main process, so the
  // overlay reports the keypress rather than deciding what it means. Select
  // mode goes through the same route, where Esc cancels without promoting.
  else if (current.mode === 'active' || current.mode === 'select') window.forge.escape();
});
