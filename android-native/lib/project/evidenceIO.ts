import * as DocumentPicker from "expo-document-picker";
import { File, FileMode } from "expo-file-system";
import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

import { base64ToBytes, bytesToBase64 } from "../codecs/base64";
import { hashEvidenceChunks, type EvidenceHashProgress } from "../engine/hash";

export interface PickedPngEvidence {
  name: string;
  uri: string;
  bytes: Uint8Array;
}

export interface SavedPngEvidence {
  uri: string;
  bytes: Uint8Array;
}

export interface PickedVideoEvidence {
  name: string;
  uri: string;
  size: number | null;
  mimeType: string | null;
}

async function readUriAsBytes(uri: string): Promise<Uint8Array> {
  const encoded = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return base64ToBytes(encoded);
}

export async function pickPngEvidence(): Promise<PickedPngEvidence | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ["image/png"],
    multiple: false,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) throw new Error("The file picker returned no file.");
  const bytes = await readUriAsBytes(asset.uri);
  if (asset.size !== undefined && asset.size !== bytes.length) {
    throw new Error(`The selected file size changed while reading (${asset.size} vs ${bytes.length} bytes).`);
  }
  return { name: asset.name || "evidence.png", uri: asset.uri, bytes };
}

/** Pick a video without copying the full source into the app cache. */
export async function pickVideoEvidence(): Promise<PickedVideoEvidence | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ["video/*"],
    multiple: false,
    copyToCacheDirectory: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) throw new Error("The file picker returned no video.");
  return {
    name: asset.name || "video-evidence",
    uri: asset.uri,
    size: asset.size ?? null,
    mimeType: asset.mimeType ?? null,
  };
}

/** Hash a provider-backed or local video URI incrementally; do not materialize the movie in JS memory. */
export async function hashVideoEvidence(
  uri: string,
  expectedSize: number | null,
  onProgress?: (progress: EvidenceHashProgress) => void,
  isCancelled?: () => boolean,
): Promise<{ md5: string; sha1: string; sha256: string; byteLength: number }> {
  const file = new File(uri);
  const handle = file.open(FileMode.ReadOnly);
  try {
    const handleSize = handle.size;
    if (expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize < 0)) {
      throw new Error("The file picker returned an invalid video size.");
    }
    if (handleSize !== null && expectedSize !== null && handleSize !== expectedSize) {
      throw new Error(`The selected video size changed before hashing (${handleSize} vs ${expectedSize} bytes).`);
    }
    const totalBytes = handleSize ?? expectedSize;
    const chunkSize = 4 * 1024 * 1024;
    const readChunks = async function* (): AsyncGenerator<Uint8Array> {
      let remaining = totalBytes;
      while (remaining === null || remaining > 0) {
        if (isCancelled?.()) throw new Error("Evidence hashing cancelled.");
        const requested = remaining === null ? chunkSize : Math.min(chunkSize, remaining);
        const chunk = handle.readBytes(requested);
        if (chunk.length === 0) break;
        if (remaining !== null) remaining -= chunk.length;
        yield chunk;
      }
    };
    return await hashEvidenceChunks(readChunks(), totalBytes, onProgress, isCancelled);
  } finally {
    handle.close();
  }
}

export async function writePreviewPng(bytes: Uint8Array): Promise<string> {
  if (!FileSystem.cacheDirectory) throw new Error("The app cache directory is unavailable.");
  const uri = `${FileSystem.cacheDirectory}clearufo-preview-${Date.now()}.png`;
  await FileSystem.writeAsStringAsync(uri, bytesToBase64(bytes), {
    encoding: FileSystem.EncodingType.Base64,
  });
  return uri;
}

/** Ask the user for a destination, save a new PNG through SAF, and read that exact file back. */
export async function savePngWithReadBack(fileBaseName: string, bytes: Uint8Array): Promise<SavedPngEvidence | null> {
  if (Platform.OS !== "android") {
    throw new Error("Saving to a user-selected folder is available in the Android APK.");
  }
  const access = FileSystem.StorageAccessFramework;
  const permission = await access.requestDirectoryPermissionsAsync();
  if (!permission.granted) return null;

  const safeName = fileBaseName.replace(/\.png$/i, "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "ClearUFO_Negative";
  const uri = await access.createFileAsync(permission.directoryUri, safeName, "image/png");
  await access.writeAsStringAsync(uri, bytesToBase64(bytes), {
    encoding: FileSystem.EncodingType.Base64,
  });
  const readBack = await readUriAsBytes(uri);
  if (readBack.length !== bytes.length) {
    throw new Error(`The saved file has ${readBack.length} bytes; expected ${bytes.length}.`);
  }
  return { uri, bytes: readBack };
}
