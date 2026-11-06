import { describe, expect, it } from "vitest";
import { zlibSync } from "fflate";

import { base64ToBytes, bytesToBase64 } from "../../lib/codecs/base64";
import { crc32, decodePNG, encodePNG } from "../../lib/codecs/image";
import { decodePngExact } from "../../lib/codecs/pngdecode";
import { MD5, SHA1, SHA256, md5 } from "../../lib/engine/hash";
import { frameToRgb16, runNegativeExport, verifyPngExport } from "../../lib/engine/imagePipeline";

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function compressedRgbPng(r: number, g: number, b: number): Uint8Array {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 1);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rawScanline = Uint8Array.from([0, r, g, b]); // filter byte, RGB samples
  const chunks = [chunk("IHDR", header), chunk("IDAT", zlibSync(rawScanline)), chunk("IEND", new Uint8Array())];
  const length = signature.length + chunks.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(length);
  png.set(signature);
  let offset = signature.length;
  for (const part of chunks) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

describe("native image forensic pipeline", () => {
  it("matches standard MD5, SHA-1, and SHA-256 vectors", () => {
    const abc = new TextEncoder().encode("abc");
    expect(new MD5().update(abc).digest()).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(new SHA1().update(abc).digest()).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(new SHA256().update(abc).digest()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("inflates a zlib-compressed PNG and returns the exact stored RGB samples", async () => {
    const decoded = await decodePngExact(compressedRgbPng(10, 120, 250));
    expect([decoded.w, decoded.h, decoded.depth, decoded.colorType]).toEqual([1, 1, 8, 2]);
    expect(Array.from(decoded.rgba)).toEqual([10, 120, 250, 255]);
  });

  it("runs Negative on-device, hashes original bytes, and verifies the written 16-bit PNG samples", async () => {
    const source = compressedRgbPng(10, 120, 250);
    const result = await runNegativeExport(source);
    expect(result.sourceHashes.md5).toBe(md5(source));
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    expect(result.sourceDepth).toBe(8);
    expect(Array.from(result.expectedSamples)).toEqual([245 * 257, 135 * 257, 5 * 257]);
    expect(result.verifiedInMemory).toBe(true);

    const decoded = decodePNG(result.outputBytes);
    expect(decoded.samples).toBeInstanceOf(Uint16Array);
    expect(Array.from(decoded.samples)).toEqual(Array.from(result.expectedSamples));
    expect(verifyPngExport(result.outputBytes, result.expectedSamples, result.samplesHash).ok).toBe(true);
  });

  it("maps floats with the reference Math.round(v * 257) rule and clamps endpoints", () => {
    const samples = frameToRgb16({
      w: 2,
      h: 1,
      d: new Float32Array([0, 127.5, 255, 17, -3, 1, 300, 0]),
    });
    expect(Array.from(samples)).toEqual([0, Math.round(127.5 * 257), 65535, 0, 257, 65535]);
  });

  it("preserves 16-bit sample values through PNG encode and decode", () => {
    const samples = new Uint16Array([0, 1, 257, 32767, 32768, 65535]);
    const png = encodePNG(2, 1, samples);
    expect(Array.from(decodePNG(png).samples)).toEqual(Array.from(samples));
  });

  it("round-trips arbitrary binary bytes through the SAF base64 representation", () => {
    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });
});
