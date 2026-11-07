import { useVideoPlayer, VideoView } from "expo-video";

/**
 * Local review playback only. Frames shown by the platform decoder are not
 * consumed by ClearUFO's numerical analysis pipeline or treated as verified samples.
 */
export function EvidenceVideoPreview({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.loop = false;
  });

  return (
    <VideoView
      player={player}
      nativeControls
      contentFit="contain"
      style={{ width: "100%", height: 230, backgroundColor: "#050505" }}
    />
  );
}
