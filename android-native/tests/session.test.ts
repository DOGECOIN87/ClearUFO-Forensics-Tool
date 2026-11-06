// The flow of the app: open the evidence, build the chain, run it, encode the result.
import { describe, expect, it } from "vitest";

import { encodePNG } from "@/lib/codecs/image";
import { decodePngExactSync } from "@/lib/codecs/pngdecode";
import { FILTERS, defaultParams } from "@/lib/shared/filters";
import { buildChain, encodeFrame, frameToRgb16, hashBytes, registerEvidence, runChain } from "@/lib/session/workbench";
import type { ChainState, EvidenceState } from "@/lib/session/store";

/** A small red/blue image as the evidence of the test. */
function makeEvidence(): EvidenceState {
  const w = 8;
  const h = 6;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = 255;
    rgb[i * 3 + 1] = 0;
    rgb[i * 3 + 2] = 0;
  }
  const bytes = encodePNG(w, h, rgb);
  const hashes = hashBytes(bytes);
  const evidence: EvidenceState = {
    name: "evidence.png",
    bytes,
    ...hashes,
    format: "png",
    decoder: "png (exact)",
    depth: 8,
    width: w,
    height: h,
    opened: new Date().toISOString(),
  };
  registerEvidence(evidence);
  return evidence;
}

const chainWith = (types: string[]): ChainState => ({
  id: "chain-1",
  name: "Evidence",
  filters: types.map((type, i) => ({
    id: `f${i}`,
    type,
    enabled: true,
    params: defaultParams(FILTERS[type]),
  })),
});

describe("the chain of the app", () => {
  it("puts the loader of the evidence in front of the filters", () => {
    const doc = buildChain(chainWith(["grayscale"]));
    expect(doc.filters[0].type).toBe("image_loader");
    expect(doc.filters[0].params.source).toBe("source-1");
    expect(doc.filters[1].type).toBe("grayscale");
  });

  it("runs the filters of the chain on the decoded evidence", async () => {
    makeEvidence();
    const rendered = await runChain(chainWith(["grayscale"]));
    expect(rendered.frame.w).toBe(8);
    expect(rendered.frame.h).toBe(6);
    expect(rendered.applied).toEqual(["image_loader", "grayscale"]);
    // the evidence is red, the grayscale filter makes every channel equal
    for (let i = 0; i < 8 * 6; i++) {
      const r = rendered.frame.d[i * 4];
      const g = rendered.frame.d[i * 4 + 1];
      const b = rendered.frame.d[i * 4 + 2];
      expect(Math.abs(r - g)).toBeLessThan(0.001);
      expect(Math.abs(g - b)).toBeLessThan(0.001);
    }
  });

  it("keeps the order of the filters", async () => {
    makeEvidence();
    const rendered = await runChain(chainWith(["negative", "grayscale"]));
    expect(rendered.applied).toEqual(["image_loader", "negative", "grayscale"]);
    // negative turns red into cyan, the grayscale then makes the three channels equal
    // (BT.601 luma of cyan: 0.587 * 255 + 0.114 * 255 = 178.755)
    const d = rendered.frame.d;
    expect(d[0]).toBeCloseTo(178.755, 2);
    expect(d[1]).toBeCloseTo(178.755, 2);
    expect(d[2]).toBeCloseTo(178.755, 2);
  });

  it("does not change the source file", async () => {
    const evidence = makeEvidence();
    const before = hashBytes(evidence.bytes);
    await runChain(chainWith(["negative"]));
    const after = hashBytes(evidence.bytes);
    expect(after).toEqual(before);
  });

  it("encodes the result in the lossless formats", async () => {
    makeEvidence();
    const rendered = await runChain(chainWith(["grayscale"]));
    const png16 = encodeFrame(rendered.frame, "png16");
    const back = decodePngExactSync(png16.bytes);
    expect(back.depth).toBe(16);
    const expected = frameToRgb16(rendered.frame);
    for (let p = 0; p < rendered.frame.w * rendered.frame.h; p++) {
      for (let c = 0; c < 3; c++) {
        expect(Math.round(back.rgba[p * 4 + c] * 257)).toBe(expected[p * 3 + c]);
      }
    }
    const bmp = encodeFrame(rendered.frame, "bmp");
    expect(bmp.bytes.length).toBeGreaterThan(0);
    const tiff = encodeFrame(rendered.frame, "tiff32f");
    expect(tiff.bytes.length).toBeGreaterThan(0);
  });
});

describe('result invalidation', () => {
  it('rejects results produced for a different chain or source and clears results on video changes', async () => {
    const { initialState, reducer } = await import('@/lib/session/store');
    const result = {
      previewUri: 'cache://preview', histogram: { hist: new Uint32Array(1280), low: 0, high: 0 },
      frame: { w: 1, h: 1, d: new Float32Array(4) }, width: 1, height: 1,
      applied: [], ms: 0, outputMd5: 'hash', at: 'now',
    };
    const expected = initialState;
    const changed = reducer(initialState, { type: 'chain', chain: { ...initialState.chain, name: 'changed' } });
    expect(reducer(changed, { type: 'result', result, expected }).result).toBeNull();
    const valid = reducer(initialState, { type: 'result', result, expected });
    expect(valid.result).toBe(result);
    expect(reducer(valid, { type: 'video', video: null }).result).toBeNull();
  });
});
