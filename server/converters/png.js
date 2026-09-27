// Minimal PNG encoder for decoded pdf.js image data (no image library needed).
import zlib from 'node:zlib';

const KIND_GRAY_1BPP = 1;
const KIND_RGB = 2;
const KIND_RGBA = 3;

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Convert pdf.js image data to 8-bit RGB or RGBA rows; returns {width, height, channels, pixels}. */
function toPixels(img) {
  const { width, height, kind, data } = img;
  if (kind === KIND_RGB) return { width, height, channels: 3, pixels: Buffer.from(data.buffer, data.byteOffset, data.length) };
  if (kind === KIND_RGBA) return { width, height, channels: 4, pixels: Buffer.from(data.buffer, data.byteOffset, data.length) };
  if (kind === KIND_GRAY_1BPP) {
    const rowBytes = (width + 7) >> 3;
    const out = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        out[y * width + x] = bit ? 255 : 0;
      }
    }
    return { width, height, channels: 1, pixels: out };
  }
  throw new Error(`Unsupported image kind ${kind}`);
}

/** Box-downsample by an integer factor so large scans do not produce huge files. */
function downsample(p, factor) {
  if (factor <= 1) return p;
  const w = Math.floor(p.width / factor);
  const h = Math.floor(p.height / factor);
  const out = Buffer.alloc(w * h * p.channels);
  const n = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < p.channels; c++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++) {
          let idx = ((y * factor + dy) * p.width + x * factor) * p.channels + c;
          for (let dx = 0; dx < factor; dx++) { sum += p.pixels[idx]; idx += p.channels; }
        }
        out[(y * w + x) * p.channels + c] = Math.round(sum / n);
      }
    }
  }
  return { width: w, height: h, channels: p.channels, pixels: out };
}

/**
 * Encode a pdf.js image object ({width, height, kind, data}) as PNG.
 * @param {object} img
 * @param {number} [maxSide] longest side allowed before downsampling
 */
export function encodePng(img, maxSide = 1600) {
  let p = toPixels(img);
  const factor = Math.ceil(Math.max(p.width, p.height) / maxSide);
  p = downsample(p, factor);
  const { width, height, channels, pixels } = p;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
