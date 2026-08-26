// What a keypress means. No electron import, so test/interaction.test.js can
// exercise it directly.
//
// Extracted because the Esc policy is a decision Jeff made on 2026-08-21
// (`escToGrid: "single"`, see docs/validation.md) with three modes and a
// double-press timing, and none of it had a test. It lived inside a function that
// also did the docking, so the only way to exercise it was to run the app.

// Whether the wall should take Esc, and what it does to the double-press clock.
//
// Returns one of:
//   'dock'   - the wall consumed it; the page must not also see it
//   'pass'   - the page gets it, and nothing changes
//   'arm'    - the page gets it, and a second press soon after will dock
//
// 'arm' exists as a distinct answer from 'pass' because the caller has to record
// when it happened. Folding the two together is what would make a double-press
// depend on the previous press being remembered somewhere else.
//
// Esc must never be a globalShortcut - it is an OS-level accelerator that fires
// regardless of focus and swallows the key before the page sees it, which would
// break Esc-to-close in every dashboard. That is why this is a decision function
// and the caller wires it per view.
function escapeDecision({ mode, escToGrid, lastEscAt = 0, now, escDoubleMs }) {
  // Hotspot mode is not a dashboard, so Esc always leaves it.
  if (mode === 'select') return 'dock';
  if (mode !== 'active') return 'pass';
  if (escToGrid === 'off') return 'pass';
  if (escToGrid === 'single') return 'dock';
  if (escToGrid !== 'double') return 'pass';

  // 'double': the first press goes to the page so it can close its own modal, and
  // a quick second one docks. A non-finite escDoubleMs would make every
  // comparison false and quietly turn double-press off, which is why config.js
  // validates it rather than trusting the default.
  const gap = now - lastEscAt;
  if (Number.isFinite(gap) && Number.isFinite(escDoubleMs) && gap < escDoubleMs) return 'dock';
  return 'arm';
}

// Cmd/Ctrl+F, and nothing that merely contains it. Shift and Alt are excluded so a
// dashboard's own Cmd+Shift+F is left alone.
function isFullscreenToggle(input) {
  return (
    !!input &&
    input.type === 'keyDown' &&
    String(input.key).toLowerCase() === 'f' &&
    !!(input.meta || input.control) &&
    !input.shift &&
    !input.alt
  );
}

module.exports = { escapeDecision, isFullscreenToggle };
