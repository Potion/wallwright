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

window.forge.onState((s) => {
  current = s;
  render();
});

window.forge.onLayoutEcho(({ id, grid, zoom }) => {
  const el = readouts.get(id);
  if (el) el.textContent = fmt(grid, zoom);
});

function fmt(grid, zoom) {
  return `${grid.width} x ${grid.height}  at ${grid.x},${grid.y}  zoom ${zoom}`;
}

function render() {
  root.innerHTML = '';
  readouts.clear();
  document.body.className = current.mode + (current.hint ? ' hint' : '');

  if (current.mode === 'grid') return renderGrid();
  if (current.mode === 'edit') return renderEdit();
  return renderActive();
}

// ---- grid -------------------------------------------------------------------

function renderGrid() {
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

function renderEdit() {
  const bar = document.createElement('div');
  bar.className = 'editbar';
  bar.innerHTML =
    '<strong>Layout edit</strong> drag to move &middot; sides resize &middot; ' +
    'corners scale &middot; <kbd>Esc</kbd> save and exit &middot; ' +
    '<kbd>Shift</kbd>+<kbd>Esc</kbd> discard';
  root.appendChild(bar);

  current.views.forEach((v) => {
    const panel = document.createElement('div');
    panel.className = 'epanel';
    place(panel, v.grid);

    const label = document.createElement('div');
    label.className = 'elabel';
    const name = document.createElement('span');
    name.className = 'ename';
    name.textContent = v.label || v.id;
    const read = document.createElement('span');
    read.className = 'eread';
    read.textContent = fmt(v.wallGrid, v.zoom);
    readouts.set(v.id, read);
    label.append(name, read);
    panel.appendChild(label);

    // The body is the move target.
    panel.addEventListener('pointerdown', (e) => {
      if (e.target !== panel && e.target !== label && e.target.parentElement !== label) return;
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
}

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

    clamp(r, kind, aspect);
    place(panel, { x: r.x, y: r.y, width: r.w, height: r.h });
    pending = r;
    if (!frame) frame = window.requestAnimationFrame(flush);
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (frame) window.cancelAnimationFrame(frame);
    flush();
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

// Report activity while the pointer is over the overlay. In active mode that is
// only the Back-button corner; the pages report their own activity through
// content-preload.js.
['mousemove', 'mousedown', 'keydown', 'wheel'].forEach((ev) =>
  window.addEventListener(ev, () => window.forge.activity(), { passive: true, capture: true })
);

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (current.mode === 'edit') window.forge.editExit({ discard: e.shiftKey });
  else if (current.mode === 'active') window.forge.back();
});
