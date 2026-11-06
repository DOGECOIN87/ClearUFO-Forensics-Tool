import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Body, Card, Note, Pill, Row, Screen, SectionTitle } from "@/components/clearufo";
import { NavBar } from "@/components/nav-bar";
import { C } from "@/lib/ui/theme";

// The video pipeline is not part of this build yet: the screen says so instead of pretending that
// something works. The image workbench is the part that is finished.
export default function VideoScreen() {
  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <Screen>
        <View>
          <Text style={styles.title}>VIDEO</Text>
          <Text style={styles.subtitle}>Demux, decode, timeline and temporal filters.</Text>
        </View>

        <Card>
          <SectionTitle index="01" title="STATUS" />
          <Row style={styles.pillRow}>
            <Pill title="NOT AVAILABLE IN THIS BUILD" tone="warning" />
          </Row>
          <Body>
            The video path of the workbench (Storage Access Framework streaming, the software demuxers and decoders,
            the timeline with the frame types and timestamps, the audio and the temporal filters) is not ported yet.
            Nothing on this screen is a simulation: the screen only reports the state of the build.
          </Body>
          <Note tone="warning">
            The image workbench (evidence, chains, exports, cases) is finished and works on the device.
          </Note>
        </Card>

        <Card>
          <SectionTitle index="02" title="WHAT THE VIDEO BUILD WILL USE" />
          <Body>
            The parts that are already in place: the colour conversion with BT.601, BT.709 and BT.2020, the range
            handling (limited and full), the chroma siting (left, center, top-left), the bicubic, bilinear and
            nearest chroma reconstruction, the HDR tone mapping of PQ and HLG streams, the temporal filters and the
            bounded frame cache of the chain engine.
          </Body>
          <Body>
            What still has to be built: the demuxers (MP4, WebM, AVI, the custom AVI and DVR variants, the
            bitstream files), the software decoders, the frame table with the types and the presentation timestamps,
            the timeline with the scrubbing and the playback, and the audio.
          </Body>
        </Card>
      </Screen>
      <NavBar active="video" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  title: { color: C.text, fontSize: 20, fontWeight: "900", letterSpacing: -0.4 },
  subtitle: { color: C.muted, fontSize: 11, marginTop: 2 },
  pillRow: { flexWrap: "wrap" },
});
