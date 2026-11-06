import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Body, Card, Note, Pill, Row, Screen, SectionTitle } from "@/components/clearufo";
import { C } from "@/lib/ui/theme";

export default function HelpScreen() {
  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <Screen>
        <View>
          <Text style={styles.title}>HELP & DIAGNOSTICS</Text>
          <Text style={styles.subtitle}>What this build does, and what it does not do.</Text>
        </View>

        <Card>
          <SectionTitle index="01" title="HOW TO USE THE APP" />
          <Body>
            1. Open an image in the Evidence tab. The app reads the bytes, hashes them (MD5, SHA-1, SHA-256) and decodes
            the image on the device.
          </Body>
          <Body>
            2. Build the chain in the Workbench tab: add a filter, change its parameters, reorder or disable it. The
            order of the list is the order of the processing.
          </Body>
          <Body>
            3. Run the chain. The result is a preview only; the evidence file is never touched.
          </Body>
          <Body>
            4. Export the result into a folder you choose. The app reads the written file back and reports its size and
            hash.
          </Body>
          <Body>
            5. Save the case. The case keeps the chains, the parameters and the hashes of the evidence on the device.
          </Body>
        </Card>

        <Card>
          <SectionTitle index="02" title="WHAT IS VERIFIED" />
          <Row style={styles.pillRow}>
            <Pill title="FILTERS BIT EXACT" tone="success" />
            <Pill title="CATALOG IDENTICAL" tone="success" />
            <Pill title="PROJECT SCHEMA 3" tone="success" />
          </Row>
          <Body>
            The filters, the kernels, the catalogue, the defaults and the migrations of the project file are compared
            with the browser workbench by the automated tests: the results are the same numbers, sample by sample.
          </Body>
          <Note>
            Two parts are deliberately different from the browser: the annotations (text and shapes) are drawn with the
            own rasterizer and a built-in bitmap font instead of the fonts of the system, and the test patterns are
            generated natively instead of with a canvas.
          </Note>
        </Card>

        <Card>
          <SectionTitle index="03" title="KNOWN GAPS OF THIS BUILD" />
          <Body>· The video path (demux, decode, timeline, playback, audio) is not ported yet.</Body>
          <Body>· The measurement and annotation tools are drawn on the viewer in the browser; here the geometry is shown but not drawn yet.</Body>
          <Body>· WebP and AVIF evidence is refused with a clear message instead of a wrong result.</Body>
          <Body>· The report is shown in the app; exporting it as a file is not implemented yet.</Body>
        </Card>

        <Card>
          <SectionTitle index="04" title="PRIVACY" />
          <Body>
            The app works offline. The evidence, the cases and the reports stay on the device. No analytics, no
            account, no upload.
          </Body>
        </Card>
      </Screen>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  title: { color: C.text, fontSize: 20, fontWeight: "900", letterSpacing: -0.4 },
  subtitle: { color: C.muted, fontSize: 11, marginTop: 2 },
  pillRow: { flexWrap: "wrap" },
});
