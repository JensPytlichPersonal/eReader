// Generates the PNG app icons without any image library (plain zlib + CRC).
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (width * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Icon: dark rounded square, open book (two pages) in white/light grey with text lines.
function icon(size) {
  const s = size / 64;
  const radius = 12 * s;
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  return png(size, size, (px, py) => {
    const x = px + 0.5, y = py + 0.5;
    if (!inRounded(x, y)) return [0, 0, 0, 0];
    const u = x / s, v = y / s;
    // left page: quad from (14,14)-(30,14)-(34,50)-(14,50) approx with spine curve
    const leftPage = u >= 14 && u <= 30 + (v - 14) * 0.11 && v >= 14 && v <= 50;
    const rightPage = u >= 34 - (v - 14) * 0.11 && u <= 50 && v >= 14 && v <= 50;
    const line = (lu, lv, w) => u >= lu && u <= lu + w && v >= lv && v <= lv + 2;
    if (leftPage) {
      if (line(18, 22, 9) || line(18, 28, 9) || line(18, 34, 7)) return [17, 17, 17, 255];
      return [255, 255, 255, 255];
    }
    if (rightPage) return [221, 221, 221, 255];
    return [17, 17, 17, 255];
  });
}

const out = path.resolve(process.argv[2] || 'public/icons');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon-192.png'), icon(192));
fs.writeFileSync(path.join(out, 'icon-512.png'), icon(512));
fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), icon(180));
console.log('icons written to', out);
