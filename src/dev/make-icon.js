// Generates build/icon.png, the source image electron-builder converts into
// platform icons. A 2x2 grid on dark ground: the exhibit, basically.
//
// Written as a generator rather than a checked-in binary blob nobody can edit.
// Run: node src/dev/make-icon.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 512;
const BG = [13, 17, 23]; // #0d1117
const POPPY = [240, 78, 35]; // Hyperquake Poppy
const DIM = [70, 26, 14];

// Four panels, inset, with a gutter. Sizes are fractions of the canvas.
const INSET = 0.14;
const GUTTER = 0.045;

function panels() {
  const a = SIZE * INSET;
  const g = SIZE * GUTTER;
  const span = SIZE - 2 * a;
  const cell = (span - g) / 2;
  const out = [];
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      out.push({
        x0: Math.round(a + col * (cell + g)),
        y0: Math.round(a + row * (cell + g)),
        x1: Math.round(a + col * (cell + g) + cell),
        y1: Math.round(a + row * (cell + g) + cell),
        // Top-left panel reads as the promoted one.
        color: row === 0 && col === 0 ? POPPY : DIM,
      });
    }
  }
  return out;
}

function render() {
  const cells = panels();
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
