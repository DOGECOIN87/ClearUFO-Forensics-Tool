// Deterministic JPEG model used by Error Level Analysis.
import { CHROMA_TABLE, jpegRoundTrip, LUMA_TABLE, quantTable } from "../src/engine/kernels/jpeg";
import { md5 } from "../src/engine/hash";

let fail = 0;
const ok = (name: string, cond: boolean, info = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${name}${info ? `  ${info}` : ""}`); if (!cond) fail++; };

// quantization tables exactly as libjpeg's jpeg_set_quality
ok("quality 50 = Annex K tables", quantTable(LUMA_TABLE, 50).join() === LUMA_TABLE.join() && quantTable(CHROMA_TABLE, 50).join() === CHROMA_TABLE.join());
ok("quality 90 (libjpeg values)", quantTable(LUMA_TABLE, 90).slice(0, 8).join() === "3,2,2,3,5,8,10,12" && quantTable(CHROMA_TABLE, 90)[63] === 20, quantTable(LUMA_TABLE, 90).slice(0, 8).join());
ok("quality 100 = all ones", quantTable(LUMA_TABLE, 100).every((v) => v === 1));
ok("quality 1 clamps to baseline 255", Math.max(...quantTable(LUMA_TABLE, 1)) === 255 && Math.min(...quantTable(CHROMA_TABLE, 1)) === 255);

// deterministic test image (integer arithmetic only): gradients, a checkerboard, a disc and pseudo-noise
const W = 203, H = 117; // odd sizes exercise partial blocks and chroma edges
const d = new Float32Array(W * H * 4);
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) % 25 - 12;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const k = (y * W + x) * 4, inDisc = (x - 120) ** 2 + (y - 60) ** 2 < 900, chk = ((x >> 3) + (y >> 3)) & 1;
  d[k] = Math.max(0, Math.min(255, Math.floor((255 * x) / W) + rnd()));
  d[k + 1] = Math.max(0, Math.min(255, (inDisc ? 220 : Math.floor((255 * y) / H)) + rnd()));
  d[k + 2] = Math.max(0, Math.min(255, (chk ? 200 : 40) + rnd()));
  d[k + 3] = 255;
}
const img = { w: W, h: H, d };
const mad = (a: Float32Array, b: Float32Array) => { let s = 0, n = 0; for (let i = 0; i < a.length; i++) if ((i & 3) !== 3) { s += Math.abs(a[i] - b[i]); n++; } return s / n; };
const bytes = (f: { d: Float32Array }) => { const o = new Uint8Array((f.d.length / 4) * 3); for (let i = 0, j = 0; i < f.d.length; i += 4) { o[j++] = f.d[i]; o[j++] = f.d[i + 1]; o[j++] = f.d[i + 2]; } return o; };

const q100 = jpegRoundTrip(img, 100, "444");
ok("quality 100, 4:4:4 is near lossless", mad(q100.d, d) < 0.8, `MAD ${mad(q100.d, d).toFixed(3)}`);
const q90 = jpegRoundTrip(img, 90, "420"), q50 = jpegRoundTrip(img, 50, "420");
ok("lower quality, larger error", mad(q50.d, d) > mad(q90.d, d), `${mad(q50.d, d).toFixed(2)} > ${mad(q90.d, d).toFixed(2)}`);
// the principle of ELA: an image already compressed at a quality changes little when compressed again at it
const again = jpegRoundTrip(q90, 90, "420");
ok("re-compression at the same quality changes much less", mad(again.d, q90.d) < 0.5 * mad(q90.d, d), `${mad(again.d, q90.d).toFixed(2)} vs ${mad(q90.d, d).toFixed(2)}`);
ok("output stays 8-bit", q50.d.every((v) => v >= 0 && v <= 255 && v === Math.round(v)));
// golden: any change of the model would change ELA results of existing cases
const h90 = md5(bytes(q90)), h444 = md5(bytes(jpegRoundTrip(img, 75, "444")));
ok("golden MD5, quality 90 4:2:0", h90 === "296f1101ab061575f2f29c2692ec3f14", h90);
ok("golden MD5, quality 75 4:4:4", h444 === "2698d494f58f9e1cf0b8dd1d1dd36182", h444);

if (fail) { console.error(`jpeg: ${fail} failed`); process.exit(1); }
console.log("jpeg: all tests passed");
