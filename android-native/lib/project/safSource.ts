// Reading the files of the device.
//
// The Storage Access Framework gives the app a document URI when the examiner picks a file. Only
// the ranges that are asked for are read, so a large video is never loaded as a whole; the
// permission of the document is used as it was granted and the file itself is never written to.
import * as FileSystem from "expo-file-system/legacy";

import { base64ToBytes } from "@/lib/codecs/base64";
import type { ByteSource } from "@/lib/codecs/byteSource";

export class SafByteSource implements ByteSource {
  constructor(public readonly uri: string, public readonly size: number) {}

  async read(off: number, len: number): Promise<Uint8Array> {
    if (len <= 0) return new Uint8Array(0);
    const start = Math.max(0, Math.min(this.size, off));
    const length = Math.max(0, Math.min(this.size - start, len));
    if (length === 0) return new Uint8Array(0);
    const encoded = await FileSystem.readAsStringAsync(this.uri, {
      encoding: FileSystem.EncodingType.Base64,
      position: start,
      length,
    });
    return base64ToBytes(encoded);
  }
}
