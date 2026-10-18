import { MD5, SHA1, SHA256 } from "../src/engine/hash";
import { createHash } from "node:crypto";
const enc = (s: string) => new TextEncoder().encode(s);
let fail = 0;
const cases = ["", "abc", "The quick brown fox jumps over the lazy dog", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000)];
for (const s of cases) {
  for (const [name, H, alg] of [["md5", MD5, "md5"], ["sha1", SHA1, "sha1"], ["sha256", SHA256, "sha256"]] as const) {
    const got = new (H as any)().update(enc(s)).digest();
    const exp = createHash(alg).update(s).digest("hex");
    if (got !== exp) { fail++; console.log("FAIL", name, JSON.stringify(s.slice(0, 20)), got, exp); }
  }
}
// incremental chunking
const big = new Uint8Array(1_000_003).map((_, i) => (i * 7 + 3) & 255);
for (const [H, alg] of [[MD5, "md5"], [SHA1, "sha1"], [SHA256, "sha256"]] as const) {
  const h = new (H as any)(); for (let o = 0; o < big.length; o += 4097) h.update(big.subarray(o, o + 4097));
  const exp = createHash(alg).update(big).digest("hex"); const got = h.digest();
  if (got !== exp) { fail++; console.log("FAIL chunked", alg); }
}
console.log(fail ? `${fail} failures` : "hash: all vectors OK");
process.exit(fail ? 1 : 0);
