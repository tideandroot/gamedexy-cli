// Minimal PNG decode/encode in pure Node (zlib only), enough for simulator and
// emulator screenshots: 8-bit RGB or RGBA, not interlaced. No dependencies, so
// `npx gamedexy` installs instantly on Mac, Windows and Linux.
import { deflateSync, inflateSync } from "node:zlib";

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let off = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (depth !== 8 || ![2, 6].includes(colorType) || interlace) throw new Error(`unsupported PNG (depth ${depth}, color ${colorType})`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 4] = line[x * bpp];
      out[(y * width + x) * 4 + 1] = line[x * bpp + 1];
      out[(y * width + x) * 4 + 2] = line[x * bpp + 2];
      out[(y * width + x) * 4 + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** RGB PNG (alpha dropped), filter 0, for thumbnails and capped full images. */
export function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4, d = y * (width * 3 + 1) + 1 + x * 3;
      raw[d] = data[s];
      raw[d + 1] = data[s + 1];
      raw[d + 2] = data[s + 2];
    }
  }
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Box-filter downscale to a target width, keeping aspect ratio. */
export function resize(img, targetWidth) {
  if (img.width <= targetWidth) return img;
  const w = targetWidth;
  const h = Math.max(1, Math.round((img.height * w) / img.width));
  const out = Buffer.alloc(w * h * 4);
  const sx = img.width / w, sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const acc = [0, 0, 0, 0];
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          acc[0] += img.data[i]; acc[1] += img.data[i + 1]; acc[2] += img.data[i + 2]; acc[3] += img.data[i + 3];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) out[o + k] = Math.round(acc[k] / n);
    }
  }
  return { width: w, height: h, data: out };
}

/** Grayscale values (0-255) of an image resized to exactly n x n (for pHash). */
export function grayGrid(img, n) {
  const out = new Float64Array(n * n);
  const sx = img.width / n, sy = img.height / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let acc = 0, cnt = 0;
      for (let yy = Math.floor(y * sy); yy < Math.max(Math.floor(y * sy) + 1, Math.floor((y + 1) * sy)); yy++) {
        for (let xx = Math.floor(x * sx); xx < Math.max(Math.floor(x * sx) + 1, Math.floor((x + 1) * sx)); xx++) {
          const i = (yy * img.width + xx) * 4;
          acc += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
          cnt++;
        }
      }
      out[y * n + x] = acc / cnt;
    }
  }
  return out;
}
