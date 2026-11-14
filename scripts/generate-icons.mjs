import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(__dirname, '..', 'build');

function clamp(v, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function mixRgb(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// Signed distance to rounded box centered at (cx, cy) with half-extents (hw, hh) and radius r
function sdRoundedBox(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - (hw - r);
  const dy = Math.abs(py - cy) - (hh - r);
  const outDist = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inDist = Math.min(Math.max(dx, dy), 0);
  return outDist + inDist - r;
}

// Signed distance to segment AB
function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay || 1));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

// Signed distance to triangle ABC (with optional corner rounding)
function sdTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const e0x = bx - ax, e0y = by - ay;
  const e1x = cx - bx, e1y = cy - by;
  const e2x = ax - cx, e2y = ay - cy;
  const v0x = px - ax, v0y = py - ay;
  const v1x = px - bx, v1y = py - by;
  const v2x = px - cx, v2y = py - cy;

  const pq0 = clamp((v0x * e0x + v0y * e0y) / (e0x * e0x + e0y * e0y));
  const pq1 = clamp((v1x * e1x + v1y * e1y) / (e1x * e1x + e1y * e1y));
  const pq2 = clamp((v2x * e2x + v2y * e2y) / (e2x * e2x + e2y * e2y));

  const d0x = v0x - e0x * pq0, d0y = v0y - e0y * pq0;
  const d1x = v1x - e1x * pq1, d1y = v1y - e1y * pq1;
  const d2x = v2x - e2x * pq2, d2y = v2y - e2y * pq2;

  const s = Math.sign(e0x * e2y - e0y * e2x);
  const d0 = d0x * d0x + d0y * d0y;
  const d1 = d1x * d1x + d1y * d1y;
  const d2 = d2x * d2x + d2y * d2y;

  const c0 = s * (v0x * e0y - v0y * e0x);
  const c1 = s * (v1x * e1y - v1y * e1x);
  const c2 = s * (v2x * e2y - v2y * e2x);

  const minD = Math.min(d0, d1, d2);
  const minC = Math.min(c0, c1, c2);
  return -Math.sqrt(minD) * Math.sign(minC);
}

function blendOver(dst, r, g, b, a) {
  const srcA = clamp(a);
  if (srcA <= 0) return;
  const outA = srcA + dst[3] * (1 - srcA);
  if (outA <= 0) return;
  dst[0] = (r * srcA + dst[0] * dst[3] * (1 - srcA)) / outA;
  dst[1] = (g * srcA + dst[1] * dst[3] * (1 - srcA)) / outA;
  dst[2] = (b * srcA + dst[2] * dst[3] * (1 - srcA)) / outA;
  dst[3] = outA;
}

function renderAppIcon(size) {
  const rgba = new Uint8Array(size * size * 4);
  const aa = 1.35 / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const px = [0, 0, 0, 0];

      // Squircle outer body
      const dBody = sdRoundedBox(u, v, 0.5, 0.5, 0.43, 0.43, 0.19);
      const bodyMask = 1 - smoothstep(-aa, aa, dBody);

      if (bodyMask > 0) {
        const bgGrad = mixRgb([26, 30, 48], [10, 12, 20], clamp(v * 0.85 + u * 0.25));
        // Subtle radial aura behind play emblem
        const distGlow = Math.hypot(u - 0.5, v - 0.46);
        const aura = Math.exp(-distGlow * distGlow * 9.5);
        const rBg = clamp(bgGrad[0] + aura * 34, 0, 255);
        const gBg = clamp(bgGrad[1] + aura * 64, 0, 255);
        const bBg = clamp(bgGrad[2] + aura * 128, 0, 255);
        blendOver(px, rBg, gBg, bBg, bodyMask);

        // Crisp inner glass rim
        const rimDist = Math.abs(dBody + 0.011);
        const rimAlpha = (1 - smoothstep(0, 0.014 + aa, rimDist)) * 0.22 * (1 - v * 0.45);
        blendOver(px, 210, 228, 255, rimAlpha * bodyMask);

        // Presentation slide frame card
        const dFrame = sdRoundedBox(u, v, 0.5, 0.5, 0.295, 0.23, 0.055);
        const frameFill = 1 - smoothstep(-aa, aa, dFrame);
        if (frameFill > 0) {
          const cardCol = mixRgb([36, 54, 96], [28, 29, 58], clamp((u + v) * 0.5));
          blendOver(px, cardCol[0], cardCol[1], cardCol[2], frameFill * 0.72);
        }
        const frameBorder = 1 - smoothstep(0, 0.016 + aa, Math.abs(dFrame));
        const borderCol = mixRgb([56, 189, 248], [139, 92, 246], clamp(u));
        blendOver(px, borderCol[0], borderCol[1], borderCol[2], frameBorder * 0.92);

        // Glowing motion play triangle (rounded slightly by offset)
        const dPlay = sdTriangle(u, v, 0.425, 0.375, 0.425, 0.625, 0.64, 0.5) - 0.016;
        const playMask = 1 - smoothstep(-aa, aa, dPlay);
        if (playMask > 0) {
          const playCol = mixRgb([125, 226, 255], [167, 139, 250], clamp((u - 0.4) * 3.5 + (v - 0.38)));
          blendOver(px, playCol[0], playCol[1], playCol[2], playMask);
        }

        // Bottom timeline progress bar + cue-point dot
        const dTrack = sdSegment(u, v, 0.26, 0.805, 0.74, 0.805) - 0.012;
        const trackMask = 1 - smoothstep(-aa, aa, dTrack);
        blendOver(px, 148, 163, 184, trackMask * 0.35);

        const dActive = sdSegment(u, v, 0.26, 0.805, 0.56, 0.805) - 0.012;
        const activeMask = 1 - smoothstep(-aa, aa, dActive);
        blendOver(px, 56, 189, 248, activeMask * 0.95);

        const dDot = Math.hypot(u - 0.56, v - 0.805) - 0.025;
        const dotMask = 1 - smoothstep(-aa, aa, dDot);
        blendOver(px, 240, 249, 255, dotMask);
      }

      const idx = (y * size + x) * 4;
      rgba[idx] = Math.round(clamp(px[0], 0, 255));
      rgba[idx + 1] = Math.round(clamp(px[1], 0, 255));
      rgba[idx + 2] = Math.round(clamp(px[2], 0, 255));
      rgba[idx + 3] = Math.round(clamp(px[3] * 255, 0, 255));
    }
  }
  return rgba;
}

function renderDocumentIcon(size) {
  const rgba = new Uint8Array(size * size * 4);
  const aa = 1.35 / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const px = [0, 0, 0, 0];

      // Document base card
      const dDoc = sdRoundedBox(u, v, 0.5, 0.5, 0.33, 0.42, 0.075);
      const docMask = 1 - smoothstep(-aa, aa, dDoc);

      if (docMask > 0) {
        const paper = mixRgb([248, 250, 252], [226, 232, 240], clamp(v));
        blendOver(px, paper[0], paper[1], paper[2], docMask);

        const borderMask = 1 - smoothstep(0, 0.014 + aa, Math.abs(dDoc));
        blendOver(px, 148, 163, 184, borderMask * 0.65 * docMask);

        // Dark cobalt badge inset at upper-center
        const dBadge = sdRoundedBox(u, v, 0.5, 0.42, 0.22, 0.19, 0.05);
        const badgeMask = 1 - smoothstep(-aa, aa, dBadge);
        if (badgeMask > 0) {
          const bCol = mixRgb([24, 34, 68], [15, 23, 42], clamp(v));
          blendOver(px, bCol[0], bCol[1], bCol[2], badgeMask);

          const dPlay = sdTriangle(u, v, 0.445, 0.335, 0.445, 0.505, 0.60, 0.42) - 0.012;
          const playMask = 1 - smoothstep(-aa, aa, dPlay);
          const pCol = mixRgb([56, 189, 248], [129, 140, 248], clamp((u - 0.4) * 4));
          blendOver(px, pCol[0], pCol[1], pCol[2], playMask);
        }

        // Bottom colored accent ribbon representing .MPRES project file
        const dRibbon = sdRoundedBox(u, v, 0.5, 0.77, 0.24, 0.075, 0.032);
        const ribMask = 1 - smoothstep(-aa, aa, dRibbon);
        const ribCol = mixRgb([37, 99, 235], [124, 58, 237], clamp(u));
        blendOver(px, ribCol[0], ribCol[1], ribCol[2], ribMask);

        // Subtle timeline strip line inside ribbon
        const dLine = sdSegment(u, v, 0.34, 0.77, 0.66, 0.77) - 0.01;
        blendOver(px, 224, 242, 254, (1 - smoothstep(-aa, aa, dLine)) * 0.9);
      }

      const idx = (y * size + x) * 4;
      rgba[idx] = Math.round(clamp(px[0], 0, 255));
      rgba[idx + 1] = Math.round(clamp(px[1], 0, 255));
      rgba[idx + 2] = Math.round(clamp(px[2], 0, 255));
      rgba[idx + 3] = Math.round(clamp(px[3] * 255, 0, 255));
    }
  }
  return rgba;
}

// CRC32 table for PNG chunks
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // Filter type 0 (None)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', idat),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Encode a 32-bit BGRA DIB entry for ICO (maximally compatible with NSIS, Explorer, & rcedit)
function encodeIcoDib(size, rgba) {
  const headerSize = 40;
  const xorSize = size * size * 4;
  const andRowStride = Math.ceil(size / 32) * 4;
  const andSize = andRowStride * size;
  const buf = Buffer.alloc(headerSize + xorSize + andSize);

  buf.writeUInt32LE(headerSize, 0);
  buf.writeInt32LE(size, 4);
  buf.writeInt32LE(size * 2, 8); // XOR + AND height
  buf.writeUInt16LE(1, 12); // planes
  buf.writeUInt16LE(32, 14); // bitCount
  buf.writeUInt32LE(0, 16); // BI_RGB
  buf.writeUInt32LE(xorSize, 20);

  // Bottom-up BGRA
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const s = (srcY * size + x) * 4;
      const d = headerSize + (y * size + x) * 4;
      buf[d] = rgba[s + 2];     // B
      buf[d + 1] = rgba[s + 1]; // G
      buf[d + 2] = rgba[s];     // R
      buf[d + 3] = rgba[s + 3]; // A
    }
  }
  return buf;
}

function buildIco(rendererFn) {
  const sizes = [16, 32, 48, 256];
  const entries = sizes.map((size) => {
    const rgba = rendererFn(size);
    const data = size === 256 ? encodePng(size, size, rgba) : encodeIcoDib(size, rgba);
    return { size, data };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // ICO type
  header.writeUInt16LE(entries.length, 4);

  const dirSize = entries.length * 16;
  let offset = 6 + dirSize;
  const dirBuffers = [];
  const dataBuffers = [];

  for (const entry of entries) {
    const dir = Buffer.alloc(16);
    dir[0] = entry.size === 256 ? 0 : entry.size;
    dir[1] = entry.size === 256 ? 0 : entry.size;
    dir[2] = 0;
    dir[3] = 0;
    dir.writeUInt16LE(1, 4);
    dir.writeUInt16LE(32, 6);
    dir.writeUInt32LE(entry.data.length, 8);
    dir.writeUInt32LE(offset, 12);
    offset += entry.data.length;
    dirBuffers.push(dir);
    dataBuffers.push(entry.data);
  }

  return Buffer.concat([header, ...dirBuffers, ...dataBuffers]);
}

fs.mkdirSync(buildDir, { recursive: true });
const png256 = encodePng(256, 256, renderAppIcon(256));
fs.writeFileSync(path.join(buildDir, 'icon.png'), png256);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), buildIco(renderAppIcon));
fs.writeFileSync(path.join(buildDir, 'file-icon.ico'), buildIco(renderDocumentIcon));

console.log('Generated build/icon.png, build/icon.ico, and build/file-icon.ico');
