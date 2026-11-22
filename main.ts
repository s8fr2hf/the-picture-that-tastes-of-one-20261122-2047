// The picture that tastes of one ingredient.
// A single ripe strawberry, drawn entirely in code (per-pixel, stdlib only),
// written to (MAKEFUN_OUTPUT_DIR || '/output') + '/entry.png'.
// No network, no external images, no dependencies.
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

const W = 1024;
const H = 1024;

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
function hash2(ix: number, iy: number): number {
  let h = (ix * 374761393 + iy * 668265263) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >> 16)) >>> 0;
  return h / 4294967295;
}

// ---- strawberry body profile: t=0 dome top, t=1 rounded bottom tip ----
// Dome cap (smooth, no flat edge, no corners) then a cone tapering to the tip.
const BODY_TOP = 178;
const BODY_BOT = 952;
const CX = 512;
const MAXW = 335;
function halfWidth(t: number): number {
  if (t < 0.16) {
    const u = t / 0.16;
    return MAXW * Math.pow(Math.sin((Math.PI / 2) * u), 0.8);
  }
  const v = (t - 0.16) / 0.84;
  return MAXW * Math.pow(1 - Math.pow(v, 2.6), 0.58);
}

// ---- seeds, precomputed per row ----
type Seed = { x: number; y: number; rx: number; ry: number };
const seedRows: Seed[][] = [];
{
  const t0 = 0.15;
  const step = 0.095;
  let row = 0;
  for (let t = t0; t < 0.93; t += step, row++) {
    const hw = halfWidth(t);
    const y = BODY_TOP + t * (BODY_BOT - BODY_TOP);
    const n = Math.max(2, Math.floor(hw / 62));
    const seeds: Seed[] = [];
    const off = row % 2 === 0 ? 0.5 : 0;
    for (let i = 0; i < n; i++) {
      const frac = n === 1 ? 0 : (i + off) / n - 0.5 / n;
      const jx = (hash2(row * 31 + 7, i * 17 + 3) - 0.5) * 16;
      const jy = (hash2(row * 13 + 5, i * 29 + 11) - 0.5) * 10;
      const x = CX + frac * 1.55 * hw + jx;
      const s = hw / MAXW;
      seeds.push({ x, y: y + jy, rx: 4.5 + 3 * s, ry: 7.5 + 4 * s });
    }
    seedRows.push(seeds);
  }
}
function seedAt(x: number, y: number): { d: number; seed: Seed } | null {
  const t = (y - BODY_TOP) / (BODY_BOT - BODY_TOP);
  const j = Math.floor((t - 0.15) / 0.095);
  let best: { d: number; seed: Seed } | null = null;
  for (let r = j - 1; r <= j + 1; r++) {
    const row = seedRows[r];
    if (!row) continue;
    for (const s of row) {
      const dx = (x - s.x) / s.rx;
      const dy = (y - s.y) / s.ry;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (!best || d < best.d) best = { d, seed: s };
    }
  }
  return best;
}

// ---- calyx leaves: 5 pointed leaves fanning from the crown ----
type Leaf = { ang: number; len: number; wid: number };
const LEAVES: Leaf[] = [
  { ang: -1.25, len: 175, wid: 62 },
  { ang: -0.62, len: 198, wid: 66 },
  { ang: 0, len: 208, wid: 68 },
  { ang: 0.62, len: 198, wid: 66 },
  { ang: 1.25, len: 175, wid: 62 },
];
const CROWN_X = 512;
const CROWN_Y = 204;
// returns 0..1 leaf coverage (1 = solid leaf), and vein-ness
function leafAt(x: number, y: number): { cov: number; vein: number } {
  let bestCov = 0;
  let bestVein = 0;
  for (const leaf of LEAVES) {
    const dx = x - CROWN_X;
    const dy = y - CROWN_Y;
    const ca = Math.cos(leaf.ang);
    const sa = Math.sin(leaf.ang);
    // rotate so leaf axis points up (-y)
    const lx = dx * ca - dy * sa;
    const ly = -dx * sa - dy * ca;
    const d = -ly / leaf.len; // 0 at crown, 1 at tip
    if (d < -0.05 || d > 1.05) continue;
    const prof = Math.pow(Math.sin(Math.PI * Math.pow(clamp(d, 0, 1), 0.75)), 0.65);
    const hw = (leaf.wid / 2) * prof + 1.5;
    const edge = hw - Math.abs(lx);
    const cov = smoothstep(-1.5, 2.5, edge);
    if (cov > bestCov) {
      bestCov = cov;
      bestVein = smoothstep(6, 0, Math.abs(lx)) * smoothstep(0.05, 0.35, d) * (1 - d * 0.4);
    }
  }
  return { cov: bestCov, vein: bestVein };
}

// ---- water droplets on the berry ----
type Drop = { x: number; y: number; r: number };
const DROPS: Drop[] = [
  { x: 420, y: 470, r: 13 },
  { x: 600, y: 380, r: 10 },
  { x: 655, y: 560, r: 12 },
  { x: 350, y: 640, r: 9 },
  { x: 520, y: 700, r: 11 },
  { x: 470, y: 300, r: 8 },
  { x: 610, y: 800, r: 9 },
];

function render(): Buffer {
  const img = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // --- warm cream background, lighter in the centre ---
      const bx = (x - 512) / 512;
      const by = (y - 430) / 512;
      const bd = Math.sqrt(bx * bx + by * by);
      const bgT = smoothstep(0.1, 1.15, bd);
      let r = lerp(251, 238, bgT);
      let g = lerp(243, 218, bgT);
      let b = lerp(223, 180, bgT);

      // --- soft ground shadow ---
      const shx = (x - 512) / 330;
      const shy = (y - 968) / 42;
      const shd = Math.sqrt(shx * shx + shy * shy);
      const shA = 0.20 * (1 - smoothstep(0.55, 1.0, shd));
      r = lerp(r, 120, shA);
      g = lerp(g, 82, shA);
      b = lerp(b, 52, shA);

      // --- strawberry body (smooth dome top, rounded tip) ---
      const t = (y - BODY_TOP) / (BODY_BOT - BODY_TOP);
      if (t >= 0 && t <= 1) {
        const hw = halfWidth(t);
        const dx = x - CX;
        const edge = hw - Math.abs(dx);
        // taper the last sliver so the tip closes cleanly, no stub
        const cov = smoothstep(-1.5, 2.0, edge) * (1 - smoothstep(0.995, 1.0, t));
        if (cov > 0) {
          const nx = dx / hw; // -1..1 across the berry
          // base red: bright fresh top, deep bottom; lighter toward lit side
          const vt = clamp(t, 0, 1);
          let br = lerp(232, 168, vt);
          let bg = lerp(72, 22, vt);
          let bb = lerp(62, 28, vt);
          // horizontal light falloff: lit from upper-left
          const lit = 1 - 0.28 * smoothstep(-0.2, 1.0, nx);
          const shade = 0.82 + 0.30 * lit;
          // rim darkening for roundness
          const rim = 0.82 + 0.18 * smoothstep(0, 0.35, edge / 40);
          br *= shade * rim;
          bg *= shade * rim;
          bb *= shade * rim;
          // subtle vertical ribbing
          const rib = 1 + 0.012 * Math.sin(nx * 44 + Math.sin(t * 9) * 2);
          br *= rib;
          bg *= rib;
          bb *= rib;
          // fine speckle noise for skin texture
          const nz = (hash2(x, y) - 0.5) * 7;
          br += nz;
          bg += nz;
          bb += nz;

          // seeds in dimples
          const s = seedAt(x, y);
          if (s && s.d < 2.1) {
            if (s.d < 1.0) {
              // pale golden seed, brighter at its top-left
              const st = clamp(1 - s.d, 0, 1);
              const sg = 228 + 10 * st;
              const sr = 240;
              const sb = 165 + 18 * st;
              const a = smoothstep(1.0, 0.82, s.d);
              br = lerp(br, sr, a);
              bg = lerp(bg, sg, a);
              bb = lerp(bb, sb, a);
            } else {
              // dimple: gentle darker ring hugging the seed
              const dim = 0.90 + 0.04 * smoothstep(1.7, 1.05, s.d);
              br *= dim;
              bg *= dim;
              bb *= dim;
            }
          }

          // big soft gloss, upper-left
          const gx = (x - 400) / 120;
          const gy = (y - 340) / 175;
          const gd = gx * gx + gy * gy;
          const gloss = 0.5 * Math.exp(-gd * 2.2);
          br = lerp(br, 255, gloss);
          bg = lerp(bg, 235, gloss);
          bb = lerp(bb, 225, gloss);
          // small secondary gloss, lower right
          const hx = (x - 660) / 70;
          const hy = (y - 640) / 110;
          const hd = hx * hx + hy * hy;
          const gloss2 = 0.22 * Math.exp(-hd * 1.4);
          br = lerp(br, 255, gloss2);
          bg = lerp(bg, 220, gloss2);
          bb = lerp(bb, 210, gloss2);

          // water droplets
          for (const dp of DROPS) {
            const ddx = x - dp.x;
            const ddy = y - dp.y;
            const dd = Math.sqrt(ddx * ddx + ddy * ddy) / dp.r;
            if (dd < 1.15) {
              const rimA = smoothstep(0.75, 1.0, dd) * 0.5;
              br = lerp(br, 255, rimA * 0.6);
              bg = lerp(bg, 240, rimA * 0.6);
              bb = lerp(bb, 230, rimA * 0.6);
              const spec = 0.85 * Math.exp(-((ddx + dp.r * 0.35) ** 2 + (ddy + dp.r * 0.35) ** 2) / (dp.r * dp.r * 0.18));
              br = lerp(br, 255, clamp(spec, 0, 1));
              bg = lerp(bg, 255, clamp(spec, 0, 1));
              bb = lerp(bb, 255, clamp(spec, 0, 1));
            }
          }

          r = lerp(r, br, cov);
          g = lerp(g, bg, cov);
          b = lerp(b, bb, cov);
        }
      }

      // --- calyx leaves (over the berry top) ---
      const lf = leafAt(x, y);
      if (lf.cov > 0) {
        const dUp = clamp((CROWN_Y - y) / 190, 0, 1);
        let lr = lerp(38, 96, dUp);
        let lg = lerp(122, 178, dUp);
        let lb = lerp(34, 58, dUp);
        // vein: lighter centre line
        lr = lerp(lr, 150, lf.vein * 0.5);
        lg = lerp(lg, 205, lf.vein * 0.5);
        lb = lerp(lb, 90, lf.vein * 0.5);
        // edge shading
        const esh = 0.85 + 0.15 * lf.cov;
        r = lerp(r, lr * esh, lf.cov);
        g = lerp(g, lg * esh, lf.cov);
        b = lerp(b, lb * esh, lf.cov);
      }

      // --- stem ---
      {
        const sx = 512 + 0.012 * (140 - y);
        const sdx = x - sx;
        if (y >= 118 && y <= 182 && Math.abs(sdx) < 12) {
          const sa = smoothstep(12, 9, Math.abs(sdx));
          const sl = 0.8 + 0.4 * smoothstep(-13, 13, sdx);
          r = lerp(r, 74 * sl, sa);
          g = lerp(g, 124 * sl, sa);
          b = lerp(b, 44 * sl, sa);
        }
      }

      const i = (y * W + x) * 3;
      img[i] = clamp(Math.round(r), 0, 255);
      img[i + 1] = clamp(Math.round(g), 0, 255);
      img[i + 2] = clamp(Math.round(b), 0, 255);
    }
  }
  return img;
}

// ---- minimal PNG encoder (zlib + CRC32, stdlib only) ----
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePng(rgb: Buffer): Buffer {
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0; // filter: none
    rgb.copy(raw, y * (1 + W * 3) + 1, y * W * 3, (y + 1) * W * 3);
  }
  const comp = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", comp),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function main(): void {
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  fs.mkdirSync(outDir, { recursive: true });
  const png = encodePng(render());
  const out = path.join(outDir, "entry.png");
  fs.writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes, ${W}x${H})`);
}

main();
