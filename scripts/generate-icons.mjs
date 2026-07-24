// Minimal from-scratch PNG encoder (no deps) — draws a simple dark square
// with a centered lighter circle so the PWA has real icon files without
// needing ImageMagick/PIL/canvas, none of which are installed on this box.
import zlib from 'node:zlib';
import fs from 'node:fs';
import crc32lib from 'node:zlib';

function crc32(buf) {
  let c, crc = 0xffffffff;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(size, { bg, fg, padding = 0.16, maskableSafe = false }) {
  const [br, bgc, bb] = bg;
  const [fr, fgc, fb] = fg;
  const raw = Buffer.alloc(size * (1 + size * 4));
  const cx = size / 2, cy = size / 2;
  const r = size * (maskableSafe ? 0.30 : 0.34);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter type none
    for (let x = 0; x < size; x++) {
      const off = rowStart + 1 + x * 4;
      const dx = x - cx, dy = y - cy;
      const inCircle = dx * dx + dy * dy <= r * r;
      if (inCircle) {
        raw[off] = fr; raw[off + 1] = fgc; raw[off + 2] = fb; raw[off + 3] = 255;
      } else {
        raw[off] = br; raw[off + 1] = bgc; raw[off + 2] = bb; raw[off + 3] = 255;
      }
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [17, 17, 20];   // near-black
const FG = [124, 156, 255]; // soft blue accent

const outDir = new URL('../public/icons/', import.meta.url);
fs.mkdirSync(outDir, { recursive: true });

const targets = [
  { name: 'icon-192.png', size: 192, maskableSafe: false },
  { name: 'icon-512.png', size: 512, maskableSafe: false },
  { name: 'icon-maskable-512.png', size: 512, maskableSafe: true },
  { name: 'apple-touch-icon.png', size: 180, maskableSafe: false },
];

for (const t of targets) {
  const png = makePng(t.size, { bg: BG, fg: FG, maskableSafe: t.maskableSafe });
  fs.writeFileSync(new URL(t.name, outDir), png);
  console.log('wrote', t.name, png.length, 'bytes');
}
