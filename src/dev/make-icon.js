// Generates build/icon.png, the source image electron-builder converts into
// platform icons.
//
// The mark is an authored montage rather than a 2x2 grid: one hero panel, a tall
// sidebar, two along the bottom. Every video wall product on the market draws a
// quad split, and a quad split is also the one layout this app exists to get away
// from, since the point is that the montage is arranged rather than given.
//
// The hero panel wears the layout editor's own corner handles, which is the
// closest thing the app has to a signature gesture: it says the wall is editable,
// not just lit.
//
// Written as a generator rather than a checked-in binary blob nobody can edit.
// Run: node src/dev/make-icon.js  (npm run icon)
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 512;
const BG = [13, 17, 23]; // wall black, #0d1117
const POPPY = [240, 78, 35]; // Hyperquake Poppy, #f04e23
const DIM = [70, 26, 14]; // an unselected panel, Poppy banked down
const GRIP = [255, 255, 255];

// The montage, in fractions of the content box. Deliberately uneven: these are
// the proportions a real wall ends up with once someone has arranged it.
const INSET = 0.115;
const PANELS = [
  { x0: 0, y0: 0, x1: 0.575, y1: 0.575, hero: true },
  { x0: 0.635, y0: 0, x1: 1, y1: 0.575 },
  { x0: 0, y0: 0.635, x1: 0.26, y1: 1 },
  { x0: 0.32, y0: 0.635, x1: 1, y1: 1 },
];
const GRIP_SIZE = 0.085 * SIZE;

function panels() {
  const a = SIZE * INSET;
  const span = SIZE - 2 * a;
  const px = (f) => Math.round(a + f * span);
  return PANELS.map((p) => ({
    x0: px(p.x0),
    y0: px(p.y0),
    x1: px(p.x1),
    y1: px(p.y1),
    color: p.hero ? POPPY : DIM,
    hero: !!p.hero,
  }));
}

// A square centred on each corner of the hero panel, straddling its edge exactly
// as the editor's grips do.
function grips(cells) {
  const hero = cells.find((c) => c.hero);
  if (!hero) return [];
  const h = Math.round(GRIP_SIZE / 2);
  const out = [];
  for (const [x, y] of [
    [hero.x0, hero.y0],
    [hero.x1, hero.y0],
    [hero.x0, hero.y1],
    [hero.x1, hero.y1],
  ]) {
    out.push({ x0: x - h, y0: y - h, x1: x + h, y1: y + h, color: GRIP });
  }
  return out;
}

function render() {
  const cells = panels();
  // The scanline below takes the first rectangle that covers a pixel, so the
  // grips go in front of the panels to paint on top of the one they belong to.
  cells.unshift(...grips(cells));
  // One extra byte per row: the PNG filter type.
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  let p = 0;
  for (let y = 0; y < SIZE; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < SIZE; x++) {
      let c = BG;
      for (const r of cells) {
        if (x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) {
          c = r.color;
          break;
        }
      }
      raw[p++] = c[0];
      raw[p++] = c[1];
      raw[p++] = c[2];
      raw[p++] = 255;
    }
  }
  return raw;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

let TABLE = null;
function crc32(buf) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(render(), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${SIZE}x${SIZE}, ${png.length} bytes)`);
