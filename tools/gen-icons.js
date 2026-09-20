/*
 * 生成扩展图标（纯 Node 实现，无第三方依赖）：
 * 橙色渐变圆角方块 + 白色时钟表盘（10:10 指针），384px 绘制后盒式降采样到 128/48/32/16。
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---------- 最小 PNG 编码器 ----------
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 绘制 ----------
function lerp(a, b, t) { return a + (b - a) * t; }
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function drawBase(S) {
  const px = Buffer.alloc(S * S * 4);
  const r0 = S * 0.17; // 圆角半径
  const cx = S / 2, cy = S * 0.53, R = S * 0.33;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // 圆角矩形遮罩（2x2 超采样做简单抗锯齿）
      let inside = 0;
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const sx = x + ox, sy = y + oy;
        const rx = Math.min(Math.max(sx, r0), S - r0);
        const ry = Math.min(Math.max(sy, r0), S - r0);
        if ((sx - rx) ** 2 + (sy - ry) ** 2 <= r0 * r0) inside++;
      }
      if (!inside) continue;
      const t = y / S;
      let r = lerp(255, 232, t), g = lerp(169, 89, t), b = lerp(77, 12, t);
      const d = Math.hypot(x - cx, y - cy);
      if (d <= R + 0.5) {
        r = 255; g = 255; b = 255; // 白色表盘
        if (d <= R) {
          const hw = Math.max(0.8, S * 0.045);
          // 时针指向 10 点方向，分针指向 2 点方向（经典 10:10）
          if (distToSeg(x, y, cx, cy, cx - R * 0.433, cy - R * 0.25) <= hw) { r = 52; g = 58; b = 64; }
          if (distToSeg(x, y, cx, cy, cx + R * 0.65, cy - R * 0.375) <= hw) { r = 52; g = 58; b = 64; }
          if (Math.hypot(x - cx, y - cy) <= Math.max(1, S * 0.05)) { r = 247; g = 103; b = 7; } // 中心点
        }
      }
      const i = (y * S + x) * 4;
      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(255 * (inside / 4));
    }
  }
  return px;
}

function downsample(src, srcSize, dstSize) {
  const f = srcSize / dstSize;
  const out = Buffer.alloc(dstSize * dstSize * 4);
  for (let y = 0; y < dstSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = 0; sy < f; sy++) {
        for (let sx = 0; sx < f; sx++) {
          const i = ((y * f + sy) * srcSize + (x * f + sx)) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3];
          n++;
        }
      }
      const o = (y * dstSize + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

const BASE = 384; // 384 = 128*3 = 48*8 = 32*12 = 16*24，整除所有目标尺寸
const base = drawBase(BASE);
const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePNG(size, downsample(base, BASE, size));
  const file = path.join(outDir, 'icon' + size + '.png');
  fs.writeFileSync(file, png);
  console.log('已生成 ' + file + '（' + png.length + ' 字节）');
}
