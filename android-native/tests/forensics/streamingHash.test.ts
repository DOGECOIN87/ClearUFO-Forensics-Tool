import { describe, expect, it } from "vitest";

import { hashEvidenceChunks } from "../../lib/engine/hash";

const encoder = new TextEncoder();

async function* chunks(...values: string[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield encoder.encode(value);
}

describe("streaming evidence hashes", () => {
  it("matches standard digest vectors across arbitrary chunk boundaries", async () => {
    const progress: Array<{ bytesRead: number; totalBytes: number | null }> =
      [];
    const result = await hashEvidenceChunks(
      chunks("a", "", "b", "c"),
      3,
      (item) => progress.push(item),
    );

    expect(result).toEqual({
      md5: "900150983cd24fb0d6963f7d28e17f72",
      sha1: "a9993e364706816aba3e25717850c26c9cd0d89d",
      sha256:
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      byteLength: 3,
    });
    expect(progress).toEqual([
      { bytesRead: 1, totalBytes: 3 },
      { bytesRead: 2, totalBytes: 3 },
      { bytesRead: 3, totalBytes: 3 },
    ]);
  });

  it("detects a stream shorter or longer than the selected file size", async () => {
    await expect(hashEvidenceChunks(chunks("abc"), 4)).rejects.toThrow(
      "changed size",
    );
    await expect(hashEvidenceChunks(chunks("abc", "d"), 3)).rejects.toThrow(
      "changed size",
    );
  });

  it("can hash streams with unknown total size", async () => {
    const result = await hashEvidenceChunks(chunks("a", "bc"), null);
    expect(result.byteLength).toBe(3);
    expect(result.sha256).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("stops between chunks when cancellation is requested", async () => {
    let cancelled = false;
    const promise = hashEvidenceChunks(
      chunks("first", "second"),
      11,
      () => {
        cancelled = true;
      },
      () => cancelled,
    );
    await expect(promise).rejects.toThrow("cancelled");
  });
});
