import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

import { base64ToBytes, bytesToBase64 } from "../codecs/base64";

export interface PickedPngEvidence {
  name: string;
  uri: string;
  bytes: Uint8Array;
}

export interface SavedPngEvidence {
  uri: string;
  bytes: Uint8Array;
}

export interface PickedImageEvidence {
  name: string;
  uri: string;
  bytes: Uint8Array;
  /** Size the picker reported, used to detect a file that changed while it was read. */
  size?: number;
}

/** Opens an image file with the system picker and reads its bytes (the file itself is not touched). */
export async function pickImageEvidence(): Promise<PickedImageEvidence | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ["image/*", "application/octet-stream"],
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
  return { name: asset.name || "evidence", uri: asset.uri, bytes, size: asset.size };
}

/** Writes the result into a file the examiner chooses and reads that exact file back. */
export async function saveFileWithReadBack(
  fileBaseName: string,
  mime: string,
  bytes: Uint8Array,
): Promise<SavedPngEvidence | null> {
  if (Platform.OS !== "android") {
    throw new Error("Saving to a user-selected folder is available in the Android APK.");
  }
  const access = FileSystem.StorageAccessFramework;
  const permission = await access.requestDirectoryPermissionsAsync();
  if (!permission.granted) return null;
  const safeName = fileBaseName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 90) || "ClearUFO_export";
  const uri = await access.createFileAsync(permission.directoryUri, safeName, mime);
  await access.writeAsStringAsync(uri, bytesToBase64(bytes), {
    encoding: FileSystem.EncodingType.Base64,
  });
  const readBack = await readUriAsBytes(uri);
  if (readBack.length !== bytes.length) {
    throw new Error(`The saved file has ${readBack.length} bytes; expected ${bytes.length}.`);
  }
  return { uri, bytes: readBack };
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
