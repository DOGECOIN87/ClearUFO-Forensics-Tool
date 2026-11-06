// Random access to the bytes of a file.
//
// The demuxers need to read a few bytes here and there in a file that can be much larger than the
// memory of the phone. The source reads the ranges that are asked for and nothing else, so a large
// video is never loaded as a whole.
//
// The interface is free of platform calls, so the demuxers can be tested without the device; the
// implementation that reads the files of the device is in lib/project/safSource.ts.
export interface ByteSource {
  /** Size of the file in bytes. */
  readonly size: number;
  /** Reads `len` bytes at `off` (a shorter array at the end of the file). */
  read(off: number, len: number): Promise<Uint8Array>;
}

/** A file that is already in memory (the tests, the small evidence files). */
export class MemoryByteSource implements ByteSource {
  constructor(public readonly bytes: Uint8Array) {}
  get size() {
    return this.bytes.length;
  }
  async read(off: number, len: number): Promise<Uint8Array> {
    const start = Math.max(0, Math.min(this.bytes.length, off));
    return this.bytes.subarray(start, Math.min(this.bytes.length, start + Math.max(0, len)));
  }
}
