// The picture that tastes of one ingredient — a single ripe strawberry,
// drawn entirely in code, per pixel, with a hand-rolled PNG encoder.
// Node 22 stdlib only. No network, no external images, no dependencies.

import * as fs from "node:fs";
import * as zlib from "node:zlib";

const W = 1024;
const H = 1024;
const CX = 512;
const TOP = 178; // top of the berry body
const BODY_H = 722; // top -> tip
const MAXW = 348; // max half-width of the berry

// ---- deterministic PRNG (mulberry32) ----
function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261122);

// ---- helpers ----
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) % 1000) / 1000;
}

// ---- berry outline ----
// t: 0 at top, 1 at tip. Half-width profile: wide shoulders, tapering tip.
function halfWidthAt(t: number): number {
  if (t <= 0 || t >= 1) return 0;
  return MAXW * Math.pow(1 - Math.pow(t, 1.9), 0.62);
}
// Rounded shoulder: the top edge of the berry curves down toward the sides.
function topYAt(dx: number): number {
  const u = clamp(Math.abs(dx) / MAXW, 0, 1);
  return TOP + 178 * Math.pow(u, 1.9);
}

// ---- seeds (achenes) in jittered rows following the berry curve ----
type Seed = { x: number; y: number; rx: number; ry: number; rot: number };
const seeds: Seed[] = [];
const seedBuckets: Seed[][] = [];
for (let r = 0; r < 20; r++) seedBuckets.push([]);
{
  const rows = 10;
  for (let ri = 0; ri < rows; ri++) {
    const y = 300 + ri * 60;
    const t = (y - TOP) / BODY_H;
    const hw = halfWidthAt(t);
    if (hw < 60) continue;
    const step = 66;
    const offset = ri % 2 === 0 ? 0 : step / 2;
    for (let x = CX - hw + 40 + offset; x < CX + hw - 36; x += step) {
      const jx = x + (rnd() - 0.5) * 20;
      const jy = y + (rnd() - 0.5) * 15;
      const s = 0.85 + rnd() * 0.3;
      const seed: Seed = { x: jx, y: jy, rx: 5.2 * s, ry: 8.6 * s, rot: (rnd() - 0.5) * 0.5 };
      seeds.push(seed);
      const b = clamp(Math.floor(jy / 64), 0, 19);
      seedBuckets[b].push(seed);
    }
  }
}
function nearestSeed(x: number, y: number): Seed | null {
  const b = clamp(Math.floor(y / 64), 0, 19);
  let best: Seed | null = null;
  let bestD = 1e9;
  for (let bi = Math.max(0, b - 1); bi <= Math.min(19, b + 1); bi++) {
    for (const s of seedBuckets[bi]) {
      const dx = (x - s.x) / (s.rx * 2.1);
      const dy = (y - s.y) / (s.ry * 2.1);
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
  }
  return bestD < 1.6 ? best : null;
}

// ---- water droplets ----
type Drop = { x: number; y: number; r: number };
const drops: Drop[] = [];
{
  const spots: Array<[number, number, number]> = [
    [0.36, 0.34, 26], [0.62, 0.3, 20], [0.3, 0.58, 22], [0.68, 0.55, 17],
    [0.45, 0.72, 15], [0.58, 0.78, 13], [0.4, 0.18, 15], [0.66, 0.42, 12],
  ];
  for (const [fx, fy, r] of spots) {
    const y = TOP + fy * BODY_H;
    const hw = halfWidthAt(fy);
    drops.push({ x: CX + (fx - 0.5) * 2 * hw * 0.82, y, r });
  }
}

// ---- calyx sepals ----
type Sepal = { bx: number; by: number; tx: number; ty: number; w: number; dark: boolean };
const sepals: Sepal[] = [];
{
  const tips: Array<[number, number, number, boolean]> = [
    [300, 250, 46, true], [392, 176, 52, false], [512, 138, 56, false],
    [628, 178, 52, false], [724, 252, 46, true], [452, 168, 48, true],
  ];
  for (const [tx, ty, w, dark] of tips) {
    sepals.push({ bx: CX, by: 208, tx, ty, w, dark });
  }
}

// ---- frame buffer ----
const img = Buffer.alloc(W * H * 3);

function setPx(x: number, y: number, r: number, g: number, b: number): void {
  const i = (y * W + x) * 3;
  img[i] = clamp(Math.round(r), 0, 255);
  img[i + 1] = clamp(Math.round(g), 0, 255);
  img[i + 2] = clamp(Math.round(b), 0, 255);
}

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = x - CX;
    // ---- warm cream background, radial light, gentle vignette ----
    const dcx = x - CX;
    const dcy = y - 470;
    const dist = Math.sqrt(dcx * dcx + dcy * dcy) / 720;
    let r = lerp(250, 232, smoothstep(0.1, 1.0, dist));
    let g = lerp(236, 208, smoothstep(0.1, 1.0, dist));
    let b = lerp(208, 168, smoothstep(0.1, 1.0, dist));

    // ---- soft ground shadow under the berry ----
    const shx = (x - CX) / 340;
    const shy = (y - 902) / 58;
    const shd = shx * shx + shy * shy;
    if (shd < 1) {
      const a = 0.30 * (1 - shd) * (1 - shd);
      r = lerp(r, 122, a);
      g = lerp(g, 96, a);
      b = lerp(b, 62, a);
    }

    // ---- berry body ----
    const t = (y - TOP) / BODY_H;
    const hw = halfWidthAt(t);
    const yTop = topYAt(dx);
    const edgeDist = Math.min(hw - Math.abs(dx), y - yTop);
    if (t > 0 && t < 1 && Math.abs(dx) < hw + 2 && y >= yTop - 2) {
      const nx = dx / hw; // -1..1 across the berry
      const ny = t;

      // base red: deep crimson at edges, bright juicy red toward lit centre
      const edgeDark = Math.pow(Math.abs(nx), 1.6);
      let br = lerp(232, 158, edgeDark);
      let bg = lerp(38, 14, edgeDark);
      let bb = lerp(44, 22, edgeDark);
      // vertical shading: darker crimson under the calyx, glowing mid, deep tip
      const vShade = 0.82 + 0.22 * Math.sin(Math.PI * clamp(ny * 1.15, 0, 1));
      br *= vShade;
      bg *= vShade;
      bb *= vShade;
      // light from upper-left
      const light = 1 + 0.16 * (1 - nx) * (1 - ny * 0.5) - 0.10 * nx * nx;
      br *= light;
      bg *= light;
      bb *= light;
      // fine skin speckle
      const sp = hash2(x, y);
      const spk = (sp - 0.5) * 14;
      br += spk;
      bg += spk * 0.4;
      bb += spk * 0.4;
      // big soft gloss highlight, upper-left (kept gentle so it reads as shine, not a blob)
      const hx = (x - 408) / 165;
      const hy = (y - 372) / 225;
      const hg = Math.exp(-(hx * hx + hy * hy));
      br = lerp(br, 255, hg * 0.38);
      bg = lerp(bg, 140, hg * 0.38);
      bb = lerp(bb, 140, hg * 0.38);
      // small sharp highlight
      const sx = (x - 356) / 46;
      const sy = (y - 300) / 70;
      const sg = Math.exp(-(sx * sx + sy * sy));
      br = lerp(br, 255, sg * 0.8);
      bg = lerp(bg, 205, sg * 0.8);
      bb = lerp(bb, 200, sg * 0.8);
      // warm rim light on the right edge
      const rim = Math.exp(-Math.pow((Math.abs(nx) - 0.92) / 0.06, 2)) * (nx > 0 ? 1 : 0);
      br = lerp(br, 255, rim * 0.35);
      bg = lerp(bg, 120, rim * 0.35);
      bb = lerp(bb, 110, rim * 0.35);

      // ---- seeds: dimple ring + pale golden achene ----
      const s = nearestSeed(x, y);
      if (s) {
        const c = Math.cos(s.rot);
        const sn = Math.sin(s.rot);
        const lx = x - s.x;
        const ly = y - s.y;
        const ex = lx * c + ly * sn;
        const ey = -lx * sn + ly * c;
        const dSeed = (ex / s.rx) * (ex / s.rx) + (ey / s.ry) * (ey / s.ry);
        const dRing = (ex / (s.rx * 1.9)) * (ex / (s.rx * 1.9)) + (ey / (s.ry * 1.9)) * (ey / (s.ry * 1.9));
        if (dRing < 1) {
          // dimple: a soft darker skin ring hugging the seed
          const ring = smoothstep(1.0, 0.55, dRing);
          br *= 1 - 0.24 * ring;
          bg *= 1 - 0.22 * ring;
          bb *= 1 - 0.22 * ring;
        }
        if (dSeed < 1) {
          const shade = 0.85 + 0.3 * (1 - clamp((-ex / s.rx + 1) / 2, 0, 1));
          br = lerp(br, 246 * shade, 0.95);
          bg = lerp(bg, 214 * shade, 0.95);
          bb = lerp(bb, 138 * shade, 0.95);
        }
      }

      // ---- water droplets: translucent beads with a bright sparkle ----
      for (const d of drops) {
        const ddx = x - d.x;
        const ddy = y - d.y;
        const dd = Math.sqrt(ddx * ddx + ddy * ddy);
        if (dd < d.r) {
          const u = dd / d.r;
          const bead = 1 - u * u;
          // mostly clear water: only a faint pale lift, stronger at the base
          br = lerp(br, 250, bead * 0.28);
          bg = lerp(bg, 240, bead * 0.28);
          bb = lerp(bb, 228, bead * 0.28);
          // darker rim and a deeper lower crescent, like refraction
          const rimD = smoothstep(0.72, 1.0, u);
          br *= 1 - 0.34 * rimD;
          bg *= 1 - 0.30 * rimD;
          bb *= 1 - 0.24 * rimD;
          // sparkle dot, upper-left of the bead
          const spx = (x - (d.x - d.r * 0.32)) / (d.r * 0.22);
          const spy = (y - (d.y - d.r * 0.32)) / (d.r * 0.22);
          const spark = Math.exp(-(spx * spx + spy * spy));
          br = lerp(br, 255, spark * 0.9);
          bg = lerp(bg, 255, spark * 0.9);
          bb = lerp(bb, 255, spark * 0.9);
        }
      }

      // anti-aliased berry edge
      const a = smoothstep(-1.2, 1.2, edgeDist);
      r = lerp(r, br, a);
      g = lerp(g, bg, a);
      b = lerp(b, bb, a);
    }

    // ---- calyx sepals (drawn over the berry top) ----
    for (const sp of sepals) {
      const vx = sp.tx - sp.bx;
      const vy = sp.ty - sp.by;
      const len = Math.sqrt(vx * vx + vy * vy);
      const ux = vx / len;
      const uy = vy / len;
      const px = x - sp.bx;
      const py = y - sp.by;
      const along = px * ux + py * uy;
      if (along < 0 || along > len) continue;
      const perp = Math.abs(-px * uy + py * ux);
      const s01 = along / len;
      const wAt = sp.w * Math.sin(Math.PI * Math.pow(s01, 0.75)) * (1 - s01 * 0.25);
      if (perp < wAt) {
        const vein = Math.exp(-Math.pow(perp / 2.2, 2));
        const base = sp.dark ? 0.72 : 1.0;
        let gr = (74 + 42 * s01) * base;
        let gg = (138 + 52 * s01) * base;
        let gb = (52 + 26 * s01) * base;
        // vein darker line down the middle
        gr *= 1 - 0.3 * vein;
        gg *= 1 - 0.3 * vein;
        gb *= 1 - 0.3 * vein;
        // soft tip shading
        const tipShade = 1 - 0.25 * smoothstep(0.8, 1.0, s01);
        const edge = smoothstep(0, 1.4, wAt - perp);
        r = lerp(r, gr * tipShade, edge);
        g = lerp(g, gg * tipShade, edge);
        b = lerp(b, gb * tipShade, edge);
      }
    }

    // ---- stem: short, angled up-right from the calyx crown ----
    {
      const sx0 = 512;
      const sy0 = 196;
      const sx1 = 566;
      const sy1 = 108;
      const vx = sx1 - sx0;
      const vy = sy1 - sy0;
      const len = Math.sqrt(vx * vx + vy * vy);
      const ux = vx / len;
      const uy = vy / len;
      const px = x - sx0;
      const py = y - sy0;
      const along = px * ux + py * uy;
      if (along >= -4 && along <= len + 4) {
        const perp = -px * uy + py * ux;
        const halfW = 9 - along * 0.03;
        if (Math.abs(perp) < halfW) {
          const hi = clamp(0.5 - perp / halfW, 0, 1);
          const sr = lerp(96, 150, hi);
          const sg = lerp(112, 152, hi);
          const sb = lerp(52, 84, hi);
          const edge = smoothstep(0, 1.2, halfW - Math.abs(perp));
          r = lerp(r, sr, edge);
          g = lerp(g, sg, edge);
          b = lerp(b, sb, edge);
        }
      }
    }

    setPx(x, y, r, g, b);
  }
}

// ---- PNG encoder (stdlib zlib + Buffer) ----
function crc32(buf: Buffer): number {
  let table = (crc32 as unknown as { t?: Int32Array }).t;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    (crc32 as unknown as { t: Int32Array }).t = table;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const raw = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 3)] = 0; // filter: none
  img.copy(raw, y * (1 + W * 3) + 1, y * W * 3, (y + 1) * W * 3);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type RGB
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
fs.mkdirSync(outDir, { recursive: true });
const outPath = `${outDir}/entry.png`;
fs.writeFileSync(outPath, png);
console.log(`wrote ${outPath} (${png.length} bytes, ${W}x${H})`);
