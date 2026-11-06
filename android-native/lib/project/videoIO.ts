// Picking a video file of the device.
//
// The file is not copied and not changed: the app keeps the document URI of the file and reads the
// ranges it needs through the Storage Access Framework.
import * as DocumentPicker from "expo-document-picker";

export interface PickedVideoEvidence {
  name: string;
  uri: string;
  size: number;
}

export async function pickVideoEvidence(): Promise<PickedVideoEvidence | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ["video/*", "application/octet-stream", "application/x-msvideo"],
    multiple: false,
    copyToCacheDirectory: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) throw new Error("The file picker returned no file.");
  const size = asset.size ?? 0;
  if (size <= 0) throw new Error("The picker did not report the size of the file.");
  return { name: asset.name || "video", uri: asset.uri, size };
}
