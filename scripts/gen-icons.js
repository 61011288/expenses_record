// One-off script to generate simple solid-color PNG app icons (no external deps).
// Run: node scripts/gen-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// draws a rounded-rect-ish "记" mark: blue rounded square bg + white circle, simple and recognizable at small sizes
function makePng(size, bg, fg) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  const cx = size / 2, cy = size / 2, r = size * 0.22;
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const inCircle = (dx * dx + dy * dy) <= r * r;
      const [r_, g_, b_, a_] = inCircle ? fg : bg;
      const off = rowStart + 1 + x * 4;
      raw[off] = r_; raw[off + 1] = g_; raw[off + 2] = b_; raw[off + 3] = a_;
    }
  }
  const idat = zlib.deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const ACCENT = [0x4f, 0x9c, 0xf9, 255];
const WHITE = [0xff, 0xff, 0xff, 255];

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

[180, 192, 512].forEach(size => {
  const png = makePng(size, ACCENT, WHITE);
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png);
  console.log('wrote icon-' + size + '.png');
});
