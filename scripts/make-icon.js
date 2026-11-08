// Gera assets/icon.png (reator arc ciano) sem dependências.
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const S = 256, px = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const dx = x - S / 2 + 0.5, dy = y - S / 2 + 0.5, r = Math.hypot(dx, dy) / (S / 2), a = Math.atan2(dy, dx);
  let c = [0, 0, 0, 0];
  const ring = (r0, w, alpha) => Math.max(0, 1 - Math.abs(r - r0) / w) * alpha;
  let v = ring(0.92, 0.05, 1) + ring(0.72, 0.035, (Math.sin(a * 10) > 0 ? 1 : 0.25)) + ring(0.5, 0.04, 0.9);
  const core = Math.max(0, 1 - r / 0.32);
  if (r < 1) c = [2, 7, 13, 255];
  const g = Math.min(1, v + core * 1.4);
  if (r < 1) c = [Math.round(2 + 200 * core * core + 40 * g), Math.round(7 + 220 * g), Math.round(13 + 242 * g), 255];
  if (r >= 0.98) c[3] = Math.max(0, Math.round(255 * (1 - (r - 0.98) / 0.02)));
  px.set(c.map((n) => Math.min(255, n)), (y * S + x) * 4);
}
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const v of b) x = t[(x ^ v) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), png);
console.log('assets/icon.png ok', png.length);
