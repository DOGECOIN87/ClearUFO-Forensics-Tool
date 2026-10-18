// Content based file identification: real headers (captured from ffmpeg / camera / DVR files)
// plus the project corpus when available (TESTMEDIA=/path/to/testmedia).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sniffBytes, withArticle, SNIFF_BYTES } from "../src/shared/sniff";
import { migrateProject, PROJECT_SCHEMA, validateProject } from "../src/shared/project";

let fail = 0;
const hex = (s: string) => Uint8Array.from(s.trim().split(/\s+/).map((x) => parseInt(x, 16)));
const pad = (d: Uint8Array, n = SNIFF_BYTES, fill = 0x00) => { const o = new Uint8Array(Math.max(n, d.length)).fill(fill); o.set(d); return o; };
const ts = (stride: number, off: number) => { const o = new Uint8Array(SNIFF_BYTES).fill(0xff); for (let p = off; p < o.length; p += stride) o[p] = 0x47; return o; };
const txt = (s: string) => new TextEncoder().encode(s);

const cases: [string, Uint8Array, string, string][] = [
  // name, bytes, expected kind, expected format
  ["webm (Chrome MediaRecorder)", pad(hex("1a 45 df a3 9f 42 86 81 01 42 f7 81 01 42 f2 81 04 42 f3 81 08 42 82 84 77 65 62 6d")), "video", "webm"],
  ["mkv", pad(hex("1a 45 df a3 a3 42 86 81 01 42 f7 81 01 42 f2 81 04 42 f3 81 08 42 82 88 6d 61 74 72 6f 73 6b 61")), "video", "mkv"],
  ["mp4 isom", pad(hex("00 00 00 20 66 74 79 70 69 73 6f 6d 00 00 02 00 69 73 6f 6d 61 76 30 31")), "video", "mp4"],
  ["mov qt", pad(hex("00 00 00 14 66 74 79 70 71 74 20 20 00 00 02 00 71 74 20 20")), "video", "mov"],
  ["mov (no ftyp)", pad(hex("00 00 00 08 77 69 64 65 00 01 00 00 6d 64 61 74")), "video", "mov"],
  ["3gp", pad(hex("00 00 00 20 66 74 79 70 33 67 70 36 00 00 01 00 33 67 70 36")), "video", "3gp"],
  ["avi", pad(hex("52 49 46 46 d2 fc 57 00 41 56 49 20 4c 49 53 54")), "video", "avi"],
  ["mpeg-ps / vob", pad(hex("00 00 01 ba 44 00 04 00 04 01 86 66 cf f8 00 00 01 bb")), "video", "mpeg-ps"],
  ["mpeg-2 es", pad(hex("00 00 01 b3 04 00 30 23 ff ff e0 18")), "video", "mpeg-es"],
  ["mpeg-ts", ts(188, 0), "video", "mpeg-ts"],
  ["m2ts", ts(192, 4), "video", "m2ts"],
  ["flv", pad(hex("46 4c 56 01 01 00 00 00 09")), "video", "flv"],
  ["asf/wmv", pad(hex("30 26 b2 75 8e 66 cf 11 a6 d9 00 aa 00 62 ce 6c")), "video", "asf"],
  ["h264 annex b", pad(hex("00 00 00 01 67 64 00 0d ac d9 41 60")), "video", "h264"],
  ["h264 aud", pad(hex("00 00 00 01 09 f0 00 00 00 01 67")), "video", "h264"],
  ["h265 annex b", pad(hex("00 00 00 01 40 01 0c 01 ff ff 01 60")), "video", "h265"],
  ["dahua dav", pad(new Uint8Array([...new Uint8Array(16), ...txt("DHAV"), 0xfc])), "video", "dahua"],
  ["hikvision", pad(txt("IMKH\x01\x02\0\0\x02")), "video", "hikvision"],
  ["jpeg", pad(hex("ff d8 ff e0 00 10 4a 46 49 46")), "image", "jpeg"],
  ["png", pad(hex("89 50 4e 47 0d 0a 1a 0a 00 00 00 0d 49 48 44 52")), "image", "png"],
  ["gif", pad(txt("GIF89a@\x000")), "image", "gif"],
  ["bmp", pad(hex("42 4d 36 24 00 00 00 00 00 00 36 00 00 00 28 00 00 00 40 00")), "image", "bmp"],
  ["tiff le", pad(hex("49 49 2a 00 ae 0d 00 00")), "image", "tiff"],
  ["tiff be", pad(hex("4d 4d 00 2a 00 00 00 08")), "image", "tiff"],
  ["webp", pad(hex("52 49 46 46 b0 02 00 00 57 45 42 50 56 50 38 20")), "image", "webp"],
  ["avif", pad(hex("00 00 00 20 66 74 79 70 61 76 69 66 00 00 00 00 61 76 69 66")), "image", "avif"],
  ["heic", pad(hex("00 00 00 18 66 74 79 70 68 65 69 63 00 00 00 00 6d 69 66 31 68 65 69 63")), "image", "heif"],
  ["mp3 id3", pad(hex("49 44 33 04 00 00 00 00 00 22")), "audio", "mp3"],
  ["mp3 frame", pad(hex("ff fb 50 c4 00 00 0a 2c")), "audio", "mpeg-audio"],
  ["wav", pad(hex("52 49 46 46 8a ac 00 00 57 41 56 45 66 6d 74 20")), "audio", "wav"],
  ["flac", pad(txt("fLaC\0\0\0\x22")), "audio", "flac"],
  ["ogg", pad(txt("OggS\0\x02")), "audio", "ogg"],
  ["aac adts", pad(hex("ff f1 50 40 20 ff fc dc")), "audio", "aac"],
  ["m4a", pad(hex("00 00 00 1c 66 74 79 70 4d 34 41 20 00 00 02 00 4d 34 41 20")), "audio", "m4a"],
  ["project json", txt('{\n "app": "LUCID Forensic Workbench",\n "schema": 1,\n "chains": []\n}'), "project", "json"],
  ["project json with BOM", new Uint8Array([0xef, 0xbb, 0xbf, ...txt('  {"app":"x"}')]), "project", "json"],
  ["json array", txt("[1,2,3]"), "other", "json"],
  ["text", txt("hello world\n"), "other", "text"],
  ["csv", txt("frame,md5\n0,abc\n"), "other", "text"],
  ["html", txt("<!DOCTYPE html><html>"), "other", "html"],
  ["svg", txt('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'), "other", "svg"],
  ["pdf", txt("%PDF-1.4\n"), "other", "pdf"],
  ["zip / docx", pad(txt("PK\x03\x04rest")), "other", "zip"],
  ["exe", pad(txt("MZ\x90\0")), "other", "exe"],
  ["empty", new Uint8Array(0), "other", "empty"],
  ["random binary", pad(hex("13 37 c0 de 00 7f 80 81 fe"), 512, 0x99), "other", "binary"],
];

for (const [name, bytes, kind, format] of cases) {
  const r = sniffBytes(bytes, bytes.length);
  if (r.kind !== kind || r.format !== format) { fail++; console.log(`FAIL ${name}: got ${r.kind}/${r.format} (${r.label}), expected ${kind}/${format}`); }
}

// Unknown binary must never be refused outright (it may be a proprietary DVR stream).
if (sniffBytes(cases.at(-1)![1]).definite) { fail++; console.log("FAIL unknown binary must not be definite"); }

// Articles used in user messages.
for (const [label, exp] of [["WebM video", "a WebM video"], ["MP4 video", "an MP4 video"], ["MPEG transport stream", "an MPEG transport stream"], ["H.265/HEVC elementary stream", "an H.265/HEVC elementary stream"],
  ["AVI video", "an AVI video"], ["JPEG image", "a JPEG image"], ["FLAC audio", "a FLAC audio"], ["unrecognized binary file", "an unrecognized binary file"], ["Matroska (MKV) video", "a Matroska (MKV) video"], ["SVG drawing", "an SVG drawing"], ["PDF document", "a PDF document"], ["HEIF image", "a HEIF image"]] as const) {
  if (withArticle(label) !== exp) { fail++; console.log(`FAIL article: ${withArticle(label)} != ${exp}`); }
}

// Project validation.
const okProject = { app: "LUCID Forensic Workbench", schema: 1, name: "P", chains: [{ id: "c1", name: "A", filters: [{ id: "f1", type: "image_loader", params: {}, enabled: true }] }], sources: {} };
const bad: [string, any][] = [["null", null], ["array", []], ["no chains", { app: "Other Tool" }], ["future schema", { ...okProject, schema: PROJECT_SCHEMA + 1 }], ["empty chain", { ...okProject, chains: [{ id: "c", filters: [] }] }],
  ["bad filter", { ...okProject, chains: [{ id: "c", filters: [{ id: 1 }] }] }], ["unknown filter", { ...okProject, chains: [{ id: "c", filters: [{ id: "f", type: "image_loader", params: {} }, { id: "g", type: "warp_drive", params: {} }] }] }]];
if (validateProject(okProject) !== null) { fail++; console.log("FAIL valid project rejected:", validateProject(okProject)); }
for (const [n, d] of bad) if (validateProject(d) === null) { fail++; console.log(`FAIL project validation accepted: ${n}`); }
if (validateProject({ ...okProject, schema: PROJECT_SCHEMA }) !== null) { fail++; console.log("FAIL current schema rejected"); }

// Migration: Video Loaders saved before the Chroma Filter existed keep the replicate decoding (results unchanged);
// explicit choices are left alone; the document is marked with the current schema.
{
  const old = { ...okProject, chains: [{ id: "c", name: "V", filters: [
    { id: "a", type: "video_loader", params: { source: "s1", colorRange: "auto", matrix: "auto", engine: "webcodecs" }, enabled: true },
    { id: "b", type: "video_loader", params: { source: "s2", chroma: "bilinear" }, enabled: true },
    { id: "c", type: "video_loader", enabled: true },
    { id: "d", type: "image_loader", params: { source: "s3" }, enabled: true },
  ] }] };
  const pinned = migrateProject(old);
  const f = old.chains[0].filters as any[];
  const checks: [boolean, string][] = [
    [pinned === 3, `three video loaders pinned (got ${pinned})`],
    [f[0].params.chroma === "nearest" && f[0].params.source === "s1", "old loader pinned to nearest, other params kept"],
    [f[1].params.chroma === "bilinear", "explicit chroma choice kept"],
    [f[0].params.hdr === "none" && f[1].params.hdr === "none" && f[2].params?.hdr === "none", "loaders saved before the HDR option keep HDR signal values (no tone mapping)"],
    [f[2].params?.chroma === "nearest", "loader without params pinned"],
    [!("chroma" in f[3].params), "image loader untouched"],
    [old.schema === PROJECT_SCHEMA, "schema updated"],
    [migrateProject(old) === 0, "migration is idempotent"],
  ];
  for (const [c, m] of checks) if (!c) { fail++; console.log(`FAIL migrateProject: ${m}`); }
}

// Real corpus (optional).
const dir = process.env.TESTMEDIA ?? "/home/user/testmedia";
if (existsSync(dir)) {
  const expect: Record<string, string> = { ".webm": "video", ".mp4": "video", ".264": "video", ".265": "video", ".avi": "video", ".dav": "video", ".mpg": "video", ".jpg": "image", ".png": "image", ".tif": "image" };
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  let n = 0;
  for (const f of walk(dir)) {
    const ext = f.slice(f.lastIndexOf(".")).toLowerCase();
    if (!expect[ext]) continue;
    const buf = readFileSync(f);
    const r = sniffBytes(new Uint8Array(buf.subarray(0, SNIFF_BYTES)), buf.length);
    n++;
    if (r.kind !== expect[ext]) { fail++; console.log(`FAIL corpus ${f}: ${r.kind}/${r.label}`); }
  }
  console.log(`sniff: ${n} corpus files checked`);
}

console.log(fail ? `sniff: ${fail} failures` : `sniff: all ${cases.length} signatures OK`);
process.exit(fail ? 1 : 0);
