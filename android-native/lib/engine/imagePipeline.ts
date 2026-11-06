import { decodePNG, encodePNG, sampleBytesLE } from "../codecs/image";
import { decodePngExact, isPng } from "../codecs/pngdecode";
import { MD5, SHA1, SHA256, md5 } from "./hash";

export interface ForensicFrame {
  w: number;
  h: number;
  d: Float32Array;
}

export interface SourceHashes {
  md5: string;
  sha1: string;
  sha256: string;
}

export interface PipelineProgress {
  label: string;
  fraction: number;
}

export interface NegativeExport {
  width: number;
  height: number;
  sourceDepth: number;
  sourceColorType: number;
  sourceHashes: SourceHashes;
  expectedSamples: Uint16Array;
  samplesHash: string;
  outputBytes: Uint8Array;
  verifiedInMemory: boolean;
}

export type ImageOperation = "negative" | "grayscale" | "brightness" | "exposure" | "red" | "green" | "blue";

export interface ExportVerification {
  ok: boolean;
  samplesHash: string;
  width: number;
  height: number;
  message: string;
}

const HASH_CHUNK_BYTES = 4 * 1024 * 1024;
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Hash the exact source file bytes on the device, yielding between chunks for UI responsiveness. */
export async function hashEvidenceBytes(
  bytes: Uint8Array,
  onProgress?: (progress: PipelineProgress) => void,
): Promise<SourceHashes> {
  const md5Hash = new MD5();
  const sha1Hash = new SHA1();
  const sha256Hash = new SHA256();
  const total = Math.max(bytes.length, 1);

  for (let offset = 0; offset < bytes.length; offset += HASH_CHUNK_BYTES) {
    const end = Math.min(bytes.length, offset + HASH_CHUNK_BYTES);
    const chunk = bytes.subarray(offset, end);
    md5Hash.update(chunk);
    sha1Hash.update(chunk);
    sha256Hash.update(chunk);
    onProgress?.({ label: "Hashing original bytes", fraction: Math.min(1, end / total) * 0.28 });
    await yieldToUi();
  }

  return { md5: md5Hash.digest(), sha1: sha1Hash.digest(), sha256: sha256Hash.digest() };
}

/** The reference Negative filter is 255 - each RGB float and passes alpha through unchanged. */
export function applyNegative(frame: ForensicFrame): ForensicFrame {
  const input = frame.d;
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 4) {
    output[i] = 255 - input[i];
    output[i + 1] = 255 - input[i + 1];
    output[i + 2] = 255 - input[i + 2];
    output[i + 3] = input[i + 3];
  }
  return { w: frame.w, h: frame.h, d: output };
}

/** Deterministic frame-wise operations used by the native workbench slice. */
export function applyImageOperation(frame: ForensicFrame, operation: ImageOperation): ForensicFrame {
  if (operation === "negative") return applyNegative(frame);
  const input = frame.d;
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 4) {
    const r = input[i], g = input[i + 1], b = input[i + 2];
    let nr = r, ng = g, nb = b;
    if (operation === "grayscale") {
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      nr = y; ng = y; nb = y;
    } else if (operation === "brightness") {
      nr = r + 32; ng = g + 32; nb = b + 32;
    } else if (operation === "exposure") {
      nr = r * 1.5; ng = g * 1.5; nb = b * 1.5;
    } else if (operation === "red") {
      ng = 0; nb = 0;
    } else if (operation === "green") {
      nr = 0; nb = 0;
    } else if (operation === "blue") {
      nr = 0; ng = 0;
    }
    output[i] = nr; output[i + 1] = ng; output[i + 2] = nb; output[i + 3] = input[i + 3];
  }
  return { w: frame.w, h: frame.h, d: output };
}

/** Match the existing writer: clamp to 0..255 then map to 0..65535 with Math.round(v * 257). */
export function frameToRgb16(frame: ForensicFrame): Uint16Array {
  const output = new Uint16Array(frame.w * frame.h * 3);
  const input = frame.d;
  for (let i = 0, k = 0; i < output.length; i += 3, k += 4) {
    for (let c = 0; c < 3; c++) {
      const value = input[k + c];
      output[i + c] = value > 0 ? (value < 255 ? Math.round(value * 257) : 65535) : 0;
    }
  }
  return output;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Decode a saved 16-bit RGB PNG and verify dimensions and every stored sample. */
export function verifyPngExport(bytes: Uint8Array, expectedSamples: Uint16Array, expectedHash: string): ExportVerification {
  const decoded = decodePNG(bytes);
  const actualBytes = sampleBytesLE(decoded.samples);
  const expectedBytes = sampleBytesLE(expectedSamples);
  const actualHash = md5(actualBytes);
  const exact = decoded.samples instanceof Uint16Array && equalBytes(actualBytes, expectedBytes);
  const ok = exact && actualHash === expectedHash;
  return {
    ok,
    samplesHash: actualHash,
    width: decoded.w,
    height: decoded.h,
    message: ok ? "Every 16-bit RGB sample read back exactly." : "The saved image does not match the processed 16-bit samples.",
  };
}

/** End-to-end first milestone: original hashes → exact PNG pixels → Negative → 16-bit PNG → read-back. */
export async function runNegativeExport(
  sourceBytes: Uint8Array,
  onProgress?: (progress: PipelineProgress) => void,
): Promise<NegativeExport> {
  if (!isPng(sourceBytes)) throw new Error("Select a PNG image. Other formats are not included in this milestone.");
  const sourceHashes = await hashEvidenceBytes(sourceBytes, onProgress);
  onProgress?.({ label: "Decoding PNG samples", fraction: 0.4 });
  const decoded = await decodePngExact(sourceBytes);
  if (decoded.animated) throw new Error("Animated PNG is not supported yet; the original evidence has not been changed.");
  onProgress?.({ label: "Applying Negative", fraction: 0.68 });
  const negative = applyNegative({ w: decoded.w, h: decoded.h, d: decoded.rgba });
  const samples = frameToRgb16(negative);
  onProgress?.({ label: "Writing 16-bit PNG", fraction: 0.82 });
  const outputBytes = encodePNG(negative.w, negative.h, samples);
  const verified = verifyPngExport(outputBytes, samples, md5(sampleBytesLE(samples)));
  if (!verified.ok) throw new Error(`In-memory export check failed: ${verified.message}`);
  onProgress?.({ label: "16-bit export verified in memory", fraction: 1 });
  return {
    width: decoded.w,
    height: decoded.h,
    sourceDepth: decoded.depth,
    sourceColorType: decoded.colorType,
    sourceHashes,
    expectedSamples: samples,
    samplesHash: verified.samplesHash,
    outputBytes,
    verifiedInMemory: verified.ok,
  };
}

/** Generalized still-image export used by the native workbench. */
export async function runImageOperationExport(
  sourceBytes: Uint8Array,
  operation: ImageOperation,
  onProgress?: (progress: PipelineProgress) => void,
): Promise<NegativeExport> {
  if (!isPng(sourceBytes)) throw new Error("Select a PNG image. Additional source formats are being ported.");
  const sourceHashes = await hashEvidenceBytes(sourceBytes, onProgress);
  onProgress?.({ label: "Decoding PNG samples", fraction: 0.4 });
  const decoded = await decodePngExact(sourceBytes);
  if (decoded.animated) throw new Error("Animated PNG is not supported yet; the original evidence has not been changed.");
  onProgress?.({ label: `Applying ${operation}`, fraction: 0.68 });
  const processed = applyImageOperation({ w: decoded.w, h: decoded.h, d: decoded.rgba }, operation);
  const samples = frameToRgb16(processed);
  onProgress?.({ label: "Writing verified 16-bit PNG", fraction: 0.82 });
  const outputBytes = encodePNG(processed.w, processed.h, samples);
  const verified = verifyPngExport(outputBytes, samples, md5(sampleBytesLE(samples)));
  if (!verified.ok) throw new Error(`In-memory export check failed: ${verified.message}`);
  onProgress?.({ label: "Export verified in memory", fraction: 1 });
  return {
    width: decoded.w, height: decoded.h, sourceDepth: decoded.depth, sourceColorType: decoded.colorType,
    sourceHashes, expectedSamples: samples, samplesHash: verified.samplesHash, outputBytes, verifiedInMemory: verified.ok,
  };
}
