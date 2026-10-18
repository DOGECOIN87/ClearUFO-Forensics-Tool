// HDR → SDR conversion (Video Loader › HDR Video):
//  1. the transfer functions hit the anchor points of BT.2100 / BT.2408 (PQ and HLG reference white = 203 cd/m²),
//  2. PQ decoding matches zimg (ffmpeg zscale), an independent implementation,
//  3. the BT.2390 EETF is the identity below its knee, monotonic, and reaches the target exactly at the peak,
//  4. the fast table-driven frame conversion matches the closed-form reference within a fraction of a code value,
//  5. results stay inside the SDR range and gamut, neutral stays neutral, and the default 1000 cd/m² is fast enough.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eetf, hdrToSdr, hdrToSdrPixel, hlgGamma, hlgInvOetf, pqEotf, pqInv, SDR_WHITE, type HdrConvert } from "../src/engine/sources/hdr";

let fail = 0, pass = 0;
const ok = (cond: unknown, msg: string) => { if (cond) { pass++; if (process.env.VERBOSE) console.log("ok  ", msg); } else { fail++; console.log("FAIL", msg); } };
let seed = 4242;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

// 1. anchors
ok(Math.abs(pqEotf(1) - 10000) < 1e-6, "PQ 1.0 = 10000 cd/m²");
ok(pqEotf(0) < 1e-6, "PQ 0 = black");
ok(Math.abs(pqEotf(0.58069) - 203) < 0.5, `PQ 58 % = 203 cd/m² (BT.2408), got ${pqEotf(0.58069).toFixed(2)}`);
ok(Math.abs(pqInv(100) - 0.50808) < 1e-4, `PQ(100 cd/m²) = 0.5081, got ${pqInv(100).toFixed(5)}`);
for (const l of [0.01, 1, 48, 100, 203, 1000, 4000]) ok(Math.abs(pqEotf(pqInv(l)) / l - 1) < 1e-9, `PQ round trip ${l} cd/m²`);
ok(Math.abs(hlgInvOetf(0.5) - 1 / 12) < 1e-12, "HLG 0.5 = 1/12 scene light (both branches agree)");
ok(Math.abs(hlgInvOetf(1) - 1) < 1e-6, "HLG 1.0 = 1");
{
  const es = hlgInvOetf(0.75), fd = 1000 * Math.pow(es, hlgGamma(1000)); // neutral grey: Ys = Es
  ok(Math.abs(fd - 203) < 1.5, `HLG 75 % neutral = 203 cd/m² on a 1000 cd/m² display (BT.2408), got ${fd.toFixed(2)}`);
}
ok(Math.abs(hlgGamma(1000) - 1.2) < 1e-12, "HLG system gamma 1.2 at 1000 cd/m²");

// 2. PQ against zimg (absolute luminance: npl=1 gives linear values in cd/m²... zscale scales by npl)
try {
  const ff = execFileSync("python3", ["-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"]).toString().trim();
  const dir = mkdtempSync(join(tmpdir(), "hdr-")), N = 1024;
  try {
    // a 1024×1 gray ramp of 16-bit full-range PQ code values → linear light relative to 203 cd/m², float out
    const raw = new Uint16Array(N * 3);
    for (let i = 0; i < N; i++) raw[i * 3] = raw[i * 3 + 1] = raw[i * 3 + 2] = Math.round((i / (N - 1)) * 65535);
    // gbrp16le: planes G, B, R
    const planes = new Uint16Array(N * 3);
    for (let i = 0; i < N; i++) { planes[i] = raw[i * 3 + 1]; planes[N + i] = raw[i * 3 + 2]; planes[2 * N + i] = raw[i * 3]; }
    writeFileSync(join(dir, "in.raw"), Buffer.from(planes.buffer));
    execFileSync(ff, ["-v", "error", "-f", "rawvideo", "-pix_fmt", "gbrp16le", "-s", `${N}x1`, "-i", join(dir, "in.raw"),
      "-vf", `zscale=tin=smpte2084:t=linear:npl=${SDR_WHITE}:pin=bt2020:p=bt2020:rin=full:r=full,format=gbrpf32le`, "-f", "rawvideo", join(dir, "out.raw")]);
    // a Buffer can be a view into a larger shared ArrayBuffer (Node 24 returns files that way): copy only its bytes
    const o = readFileSync(join(dir, "out.raw")), out = new Float32Array(o.buffer.slice(o.byteOffset, o.byteOffset + o.byteLength));
    let worst = 0;
    for (let i = 0; i < N; i++) {
      const e = raw[i * 3] / 65535, ref = pqEotf(e) / SDR_WHITE, z = out[i]; // G plane first
      const err = Math.abs(z - ref) / Math.max(ref, 1e-3);
      if (ref > 1e-3 && ref < 40) worst = Math.max(worst, err);
    }
    ok(worst < 2e-3, `PQ EOTF matches zimg within 0.2 % (worst ${(worst * 100).toFixed(4)} %)`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
} catch (e) { console.log("skip zimg cross-check:", (e as Error).message.split("\n")[0]); }

// 3. EETF
{
  const peak = 1000, target = SDR_WHITE;
  ok(Math.abs(eetf(peak, peak, target) - target) < 1e-6, "EETF(peak) = target");
  ok(Math.abs(eetf(20, peak, target) - 20) < 1e-9 && Math.abs(eetf(80, peak, target) - 80) < 1e-9, "EETF is the identity below the knee (20, 80 cd/m²)");
  let prev = -1, mono = true;
  for (let l = 0; l <= 1200; l += 0.5) { const v = eetf(l, peak, target); if (v < prev - 1e-9 || v > target + 1e-9) mono = false; prev = v; }
  ok(mono, "EETF monotonic and ≤ target on 0–1200 cd/m²");
  ok(eetf(150, 150, target) === 150, "no tone mapping when the source peak is below the target");
}

// 4. tables vs closed form; 5. range, gamut, neutrality
for (const o of [{ transfer: "hlg", bt2020: true, peak: 1000 }, { transfer: "pq", bt2020: true, peak: 1000 }, { transfer: "pq", bt2020: true, peak: 4000 }, { transfer: "pq", bt2020: false, peak: 1000 }, { transfer: "hlg", bt2020: true, peak: 2000 }] as HdrConvert[]) {
  const W = 512, H = 64, d = new Float32Array(W * H * 4);
  for (let i = 0; i < d.length; i += 4) {
    const neutral = (i / 4) % 7 === 0, v = rnd();
    d[i] = neutral ? v : rnd(); d[i + 1] = neutral ? v : rnd(); d[i + 2] = neutral ? v : rnd(); d[i + 3] = 1;
  }
  // a few exact edge values
  d.set([0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0.75, 0.75, 0.75, 1], 0);
  const src = Float32Array.from(d);
  for (let i = 0; i < d.length; i += 4) { d[i] *= 255; d[i + 1] *= 255; d[i + 2] *= 255; d[i + 3] = 255; }
  const f = hdrToSdr({ w: W, h: H, d }, o);
  let worst = 0, inRange = true, neutralOk = true, alphaOk = true;
  for (let i = 0; i < d.length; i += 4) {
    const ref = hdrToSdrPixel([src[i], src[i + 1], src[i + 2]], o);
    for (let c = 0; c < 3; c++) { worst = Math.max(worst, Math.abs(f.d[i + c] - ref[c] * 255)); if (!(f.d[i + c] >= -1e-3 && f.d[i + c] <= 255 + 1e-3)) inRange = false; }
    if (src[i] === src[i + 1] && src[i + 1] === src[i + 2] && (Math.abs(f.d[i] - f.d[i + 1]) > 0.02 || Math.abs(f.d[i + 1] - f.d[i + 2]) > 0.02)) neutralOk = false;
    if (f.d[i + 3] !== 255) alphaOk = false;
  }
  const tag = `${o.transfer} ${o.bt2020 ? "BT.2020" : "BT.709"} ${o.peak} cd/m²`;
  ok(worst < 0.35, `${tag}: tables match the closed form within 0.35 code values (worst ${worst.toFixed(3)})`);
  ok(inRange, `${tag}: output within 0–255`);
  ok(neutralOk, `${tag}: neutral input stays neutral`);
  ok(alphaOk, `${tag}: alpha kept`);
}
{
  // reference white lands near the top of SDR without clipping; black stays black; peak white is SDR white
  const o: HdrConvert = { transfer: "hlg", bt2020: true, peak: 1000 };
  const w = hdrToSdrPixel([0.75, 0.75, 0.75], o)[0], k = hdrToSdrPixel([0, 0, 0], o)[0], top = hdrToSdrPixel([1, 1, 1], o)[0];
  ok(w > 0.82 && w < 0.95, `HLG reference white → ${(w * 100).toFixed(1)} % SDR (bright, below clipping)`);
  ok(k === 0 && Math.abs(top - 1) < 1e-9, "black → 0 %, HLG peak → 100 %");
  const pq = hdrToSdrPixel([pqInv(48), pqInv(48), pqInv(48)], { transfer: "pq", bt2020: true, peak: 1000 })[0];
  ok(Math.abs(pq - Math.pow(48 / SDR_WHITE, 1 / 2.4)) < 1e-9, "PQ mid-tones (48 cd/m²) pass unchanged (gamma 2.4 of 48/203)");
  const g = hdrToSdrPixel([0, 0.75, 0], o);
  ok(g.every((c) => c >= 0 && c <= 1) && g[1] > g[0] && g[1] > g[2], "saturated BT.2020 green: in gamut, still green");
}
{
  const W = 1920, H = 1080, d = new Float32Array(W * H * 4);
  for (let i = 0; i < d.length; i++) d[i] = (i * 37) % 256;
  hdrToSdr({ w: W, h: H, d: d.slice(0, W * 64 * 4) }, { transfer: "hlg", bt2020: true, peak: 1000 }); // warm up
  const t0 = performance.now();
  hdrToSdr({ w: W, h: H, d }, { transfer: "hlg", bt2020: true, peak: 1000 });
  const ms = performance.now() - t0;
  console.log(`  1080p HLG frame: ${ms.toFixed(0)} ms`);
  ok(ms < 400, "1080p frame converts in well under half a second");
}

console.log(`hdr: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
