// What a panel is allowed to load, and where it is allowed to go. Plain
// functions over plain values, no electron import, so test/policy.test.js can
// exercise it directly. Extracted from main.js because this is the code
// `allowedOrigins` will be judged on once the real Honeywell domains are known,
// and it had no tests at all while it decided whether a navigation was blocked.
//
// Two questions, deliberately kept apart:
//
//   - Is this ORIGIN one this panel may reach? Configurable per view via
//     `allowedOrigins`, empty means permissive. A misconfiguration guard that an
//     administrator tunes.
//   - Is this SCHEME one any panel may ever load? Fixed, and not configurable.
//     No config should be able to point a wall panel at the show PC's disk.
//
// Verdicts are `{ ok }` or `{ ok: false, reason }` rather than booleans, because
// every caller here logs why it refused. A wall that quietly ignores an
// instruction is worse than one that says what it would not do.

// http and https only.
//
// Anything a dashboard legitimately is will be one of these, and each of the
// alternatives is a way to make a panel do something it should not: `file:`
// reads the local disk, `javascript:` injects into whatever is loaded, `data:`
// is an arbitrary inline document, and `chrome:` / `devtools:` are Chromium's
// own pages. The app's own placeholder and diagnostic pages are `data:` URLs
// loaded directly by main.js rather than routed through here, so they are
// unaffected by this list.
const PANEL_SCHEMES = ['http:', 'https:'];

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function schemeOf(url) {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

// Absent or empty allowedOrigins means permissive, which is today's behaviour and
// the right default while the real domains are unknown. Populate it in config to
// enforce; no code change is needed then.
function isOriginAllowed(url, allowedOrigins) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) return true;
  const origin = originOf(url);
  return !!origin && allowedOrigins.includes(origin);
}

// Whether a panel may be pointed at this URL at all, before asking where it may
// navigate afterwards. An absent or empty URL is fine: it means the placeholder.
function panelUrlVerdict(url) {
  if (url === undefined || url === null || url === '') return { ok: true };
  if (typeof url !== 'string') return { ok: false, reason: 'url must be a string' };
  const scheme = schemeOf(url);
  if (!scheme) return { ok: false, reason: `"${url}" is not a URL` };
  if (!PANEL_SCHEMES.includes(scheme)) {
    return {
      ok: false,
      reason: `${scheme} is not allowed for a panel (${PANEL_SCHEMES.join(' and ')} only)`,
    };
  }
  return { ok: true };
}

// A partition is a storage key, and in this app its entire purpose is that a
// login survives a reload and a rebuild. A name without the `persist:` prefix is
// an in-memory session, so it signs the panel out every time the view is rebuilt,
// which is the exact failure the partition exists to prevent. Refused rather than
// warned about, because the symptom shows up much later than the cause.
function partitionVerdict(partition) {
  if (partition === undefined || partition === null) return { ok: true };
  if (typeof partition !== 'string' || partition === '') {
    return { ok: false, reason: 'partition must be a non-empty string' };
  }
  if (!partition.startsWith('persist:')) {
    return {
      ok: false,
      reason: `"${partition}" has no persist: prefix, so the session would not survive a rebuild`,
    };
  }
  return { ok: true };
}

// Whether a panel may have a permission, given its `allowedPermissions`.
//
// **The polarity is the opposite of isOriginAllowed above, deliberately.** An
// absent or empty `allowedOrigins` is permissive, because a wall with no origin
// list configured still has to load its dashboards. An absent or empty
// `allowedPermissions` allows nothing, because a dashboard that has not been
// asked about does not need the camera. The two sit next to each other and read
// alike, so the difference is worth stating rather than inferring.
//
// Measured before this existed (`npm run probe:perm`, docs/validation.md): with
// no handler installed Electron grants microphone, camera and notifications
// silently, and leaves geolocation pending forever.
//
// The permission strings are Chromium's, not ours - 43.4.1 produced `media`,
// `geolocation`, `notifications`, `web-app-installation` and
// `speaker-selection`, and 44.1.0 produces the same set - and they change between
// versions. That is why this is a config array rather than an enum: a dashboard
// that turns out to need one is a config edit, not a release.
function isPermissionAllowed(permission, allowedPermissions) {
  if (!Array.isArray(allowedPermissions) || allowedPermissions.length === 0) return false;
  return allowedPermissions.includes(permission);
}

// A rectangle arriving from the renderer. Every field has to be a finite number:
// anything else becomes NaN, survives clampGrid unchanged, reaches setBounds, and
// is then written into the config file by saveViews.
function rectVerdict(rect) {
  if (!rect || typeof rect !== 'object') return { ok: false, reason: 'rect must be an object' };
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!Number.isFinite(rect[key])) {
      return { ok: false, reason: `rect.${key} must be a finite number` };
    }
  }
  return { ok: true };
}

module.exports = {
  PANEL_SCHEMES,
  originOf,
  schemeOf,
  isOriginAllowed,
  isPermissionAllowed,
  panelUrlVerdict,
  partitionVerdict,
  rectVerdict,
};
