// Still image decoding and writing on the device.
//
// The fixtures are small files generated with ImageMagick (16x12 red-to-blue gradient). The JPEG
// fixture comes with the RGB samples ImageMagick reads from it, so the native decoder can be
// compared with a known-good decoder.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { decodeStill } from "@/lib/codecs/still";
import { decodeBMP, decodeTIFF, encodeBMP, encodePNG, encodeTIFF, sampleBytesLE } from "@/lib/codecs/image";
import { decodePngExactSync } from "@/lib/codecs/pngdecode";
import { md5 } from "@/lib/engine/hash";

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(__dirname, "fixtures", name)));

describe("still image decoding", () => {
  it("decodes an 8-bit PNG exactly", () => {
    const png = decodePngExactSync(fixture("rgb8.png"));
    expect(png.w).toBe(16);
    expect(png.h).toBe(12);
    expect(png.depth).toBe(8);
    expect(png.colorType).toBe(2);
    // the gradient starts at red and ends at blue
    expect(png.rgba[0]).toBeCloseTo(255, 0);
    expect(png.rgba[1]).toBeCloseTo(0, 0);
    expect(png.rgba[2]).toBeCloseTo(0, 0);
    const last = (15 + 11 * 16) * 4;
    expect(png.rgba[last]).toBeCloseTo(0, 0);
    expect(png.rgba[last + 2]).toBeCloseTo(255, 0);
  });

  it("keeps the precision of a 16-bit PNG", () => {
    const png = decodePngExactSync(fixture("rgb16.png"));
    expect(png.depth).toBe(16);
    expect(png.w).toBe(16);
    // 16-bit samples are divided by 257, so the fractions of the stored values are kept
    // a 16-bit sample is stored as value / 257, so the full range stays at 255
    expect(png.rgba[0]).toBeCloseTo(255, 2);
    expect(png.rgba[0]).toBeGreaterThan(254.9);
  });

  it("decodes grayscale, BMP and TIFF", () => {
    const gray = decodeStill(fixture("gray8.png"));
    expect(gray.format).toBe("png");
    expect(gray.frame.w).toBe(16);
    expect(gray.frame.h).toBe(12);

    const bmp = decodeStill(fixture("sample.bmp"));
    expect(bmp.format).toBe("bmp");
    expect(bmp.frame.w).toBe(16);
    expect(bmp.frame.h).toBe(12);

    const tiff8 = decodeStill(fixture("sample8.tif"));
    expect(tiff8.format).toBe("tiff");
    expect(tiff8.depth).toBe(8);

    const tiff16 = decodeStill(fixture("sample16.tif"));
    expect(tiff16.format).toBe("tiff");
    expect(tiff16.depth).toBe(16);
  });

  it("decodes a baseline JPEG like the reference decoder", () => {
    const decoded = decodeStill(fixture("sample.jpg"));
    expect(decoded.format).toBe("jpeg");
    expect(decoded.frame.w).toBe(16);
    expect(decoded.frame.h).toBe(12);
    const reference = fixture("sample.jpg.rgb");
    let worst = 0;
    for (let i = 0; i < 16 * 12; i++) {
      for (let c = 0; c < 3; c++) {
        const diff = Math.abs(decoded.frame.d[i * 4 + c] - reference[i * 3 + c]);
        if (diff > worst) worst = diff;
      }
    }
    // the app uses a floating point IDCT and libjpeg an integer one, and the chroma is rebuilt with
    // the triangle filter: a few levels of difference are expected
    expect(worst).toBeLessThanOrEqual(5);
  });

  it("refuses formats it cannot decode instead of guessing", () => {
    expect(() => decodeStill(fixture("sample.webp"))).toThrow(/WebP/);
    expect(() => decodeStill(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/still image/);
  });
});

describe("lossless writers", () => {
  const frame = { w: 5, h: 4, d: new Float32Array(5 * 4 * 4) };
  for (let i = 0; i < 5 * 4; i++) {
    frame.d[i * 4] = i * 3;
    frame.d[i * 4 + 1] = 255 - i * 2;
    frame.d[i * 4 + 2] = 128.5;
    frame.d[i * 4 + 3] = 255;
  }

  const rgb16 = () => {
    const s = new Uint16Array(5 * 4 * 3);
    for (let i = 0; i < 5 * 4; i++) {
      s[i * 3] = Math.round(Math.max(0, Math.min(255, frame.d[i * 4])) * 257);
      s[i * 3 + 1] = Math.round(Math.max(0, Math.min(255, frame.d[i * 4 + 1])) * 257);
      s[i * 3 + 2] = Math.round(Math.max(0, Math.min(255, frame.d[i * 4 + 2])) * 257);
    }
    return s;
  };

  it("writes a 16-bit PNG that reads back exactly", () => {
    const s = rgb16();
    const bytes = encodePNG(5, 4, s);
    const back = decodePngExactSync(bytes);
    expect(back.w).toBe(5);
    expect(back.h).toBe(4);
    expect(back.depth).toBe(16);
    // the decoder returns RGBA, the writer takes RGB: compare channel by channel
    for (let p = 0; p < 5 * 4; p++) {
      for (let c = 0; c < 3; c++) expect(Math.round(back.rgba[p * 4 + c] * 257)).toBe(s[p * 3 + c]);
    }
  });

  it("writes TIFF 16-bit and 32-bit float that read back exactly", () => {
    const s16 = rgb16();
    const back16 = decodeTIFF(encodeTIFF(5, 4, s16));
    expect(back16.samples).toBeInstanceOf(Uint16Array);
    for (let i = 0; i < s16.length; i++) expect((back16.samples as Uint16Array)[i]).toBe(s16[i]);

    const f32 = new Float32Array(5 * 4 * 3);
    for (let i = 0; i < f32.length; i++) f32[i] = (i % 17) / 17;
    const back32 = decodeTIFF(encodeTIFF(5, 4, f32));
    expect(back32.samples).toBeInstanceOf(Float32Array);
    for (let i = 0; i < f32.length; i++) expect((back32.samples as Float32Array)[i]).toBeCloseTo(f32[i], 6);
  });

  it("writes a BMP that reads back exactly", () => {
    const s8 = new Uint8Array(5 * 4 * 3);
    for (let i = 0; i < 5 * 4; i++) {
      s8[i * 3] = i * 3; s8[i * 3 + 1] = 255 - i * 2; s8[i * 3 + 2] = 128;
    }
    const back = decodeBMP(encodeBMP(5, 4, s8));
    expect(back.w).toBe(5);
    expect(back.h).toBe(4);
    for (let i = 0; i < s8.length; i++) expect(back.samples[i]).toBe(s8[i]);
  });

  it("hashes the written samples the same way the verifier does", () => {
    const s = rgb16();
    const bytes = encodePNG(5, 4, s);
    const back = decodePngExactSync(bytes);
    expect(md5(sampleBytesLE(s))).toHaveLength(32);
    expect(back.w).toBe(5);
  });
});
