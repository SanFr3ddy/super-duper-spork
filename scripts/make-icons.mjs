/**
 * Genera los íconos de la app instalable (PWA / pantalla de inicio del iPhone) sin dependencias:
 * PNG RGBA escrito a mano con node:zlib.
 *
 *   node scripts/make-icons.mjs
 *
 * Diseño: fondo #0b0b0b a sangre, cuadrado redondeado rojo #e5202e centrado y una "F" blanca hecha con
 * rectángulos. Todo lo importante cabe en el círculo central del 80 % (zona segura de los íconos "maskable").
 * Salida en client/public/: apple-touch-icon.png (180), icon-192.png y icon-512.png.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'client', 'public');

const BG = [0x0b, 0x0b, 0x0b];
const RED = [0xe5, 0x20, 0x2e];
const WHITE = [0xff, 0xff, 0xff];

/** Muestras por eje dentro de cada píxel (4 x 4 = 16) para suavizar bordes. */
const SS = 4;

// Geometría en fracciones del lado del ícono, relativa al centro (x hacia la derecha, y hacia abajo).
const SQUARE_HALF = 0.32; // cuadrado rojo de 64 % del lado
const SQUARE_RADIUS = 0.13; // esquina más lejana a 0.399 del centro: dentro de la zona segura (0.40)
/** Rectángulos de la "F": [x0, y0, x1, y1]. */
const F_RECTS = [
  [-0.12, -0.185, -0.035, 0.185], // asta vertical
  [-0.12, -0.185, 0.145, -0.1], // brazo superior
  [-0.12, -0.035, 0.095, 0.045], // brazo medio
];

function insideRoundedSquare(x, y) {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax > SQUARE_HALF || ay > SQUARE_HALF) return false;
  const inner = SQUARE_HALF - SQUARE_RADIUS;
  const dx = ax - inner;
  const dy = ay - inner;
  if (dx <= 0 || dy <= 0) return true;
  return dx * dx + dy * dy <= SQUARE_RADIUS * SQUARE_RADIUS;
}

function insideF(x, y) {
  return F_RECTS.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
}

const mix = (a, b, t) => a + (b - a) * t;

/** Devuelve los bytes RGBA (sin filtro) de un ícono de size x size. */
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const total = SS * SS;
  for (let py = 0; py < size; py++) {
    for (let pxX = 0; pxX < size; pxX++) {
      let red = 0;
      let white = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (pxX + (sx + 0.5) / SS) / size - 0.5;
          const y = (py + (sy + 0.5) / SS) / size - 0.5;
          if (insideRoundedSquare(x, y)) {
            if (insideF(x, y)) white++;
            else red++;
          }
        }
      }
      const cr = red / total;
      const cw = white / total;
      const i = (py * size + pxX) * 4;
      for (let c = 0; c < 3; c++) {
        // Capas: fondo -> rojo (cobertura del cuadrado sin la F) -> blanco (cobertura de la F).
        px[i + c] = Math.round(BG[c] * (1 - cr - cw) + RED[c] * cr + WHITE[c] * cw);
      }
      px[i + 3] = 255; // opaco: iOS rellena la transparencia con negro de todos modos
    }
  }
  return px;
}

// --- Codificación PNG ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // ancho
  ihdr.writeUInt32BE(size, 4); // alto
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compresión deflate
  ihdr[11] = 0; // filtro estándar
  ihdr[12] = 0; // sin entrelazado
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filtro "None" por fila
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --- Salida -------------------------------------------------------------------------------------
const TARGETS = [
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
];

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const { file, size } of TARGETS) {
  const png = encodePng(size, drawIcon(size));
  const dest = path.join(OUT_DIR, file);
  fs.writeFileSync(dest, png);
  console.log(`[icons] ${path.relative(ROOT, dest)} (${size}x${size}, ${png.length} bytes)`);
}
