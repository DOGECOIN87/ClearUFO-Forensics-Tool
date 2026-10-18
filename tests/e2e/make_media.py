"""Generates the test media corpus (requires: pip install imageio-ffmpeg pillow)."""
import io, os, re, struct, subprocess, sys
import imageio_ffmpeg
from PIL import Image, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/lucid-testmedia"
FF = imageio_ffmpeg.get_ffmpeg_exe()
os.makedirs(f"{OUT}/seq", exist_ok=True)
def ff(*a): subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y", *a], check=True)
SRC = ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=2"]
ff(*SRC, "-f", "lavfi", "-i", "sine=frequency=440:duration=2,volume=0.6", "-c:v", "libvpx-vp9", "-b:v", "800k", "-g", "10", "-c:a", "libopus", "-shortest", f"{OUT}/vp9_opus.webm")
ff(*SRC, "-c:v", "libaom-av1", "-cpu-used", "8", "-b:v", "500k", "-g", "12", f"{OUT}/av1.mp4")
ff("-f", "lavfi", "-i", "testsrc2=size=352x288:rate=25:duration=2.4", "-c:v", "libx264", "-preset", "fast", "-bf", "2", "-g", "12", "-keyint_min", "12", "-sc_threshold", "0", "-bsf:v", "h264_mp4toannexb", "-f", "h264", f"{OUT}/bframes.264")
ff("-f", "lavfi", "-i", "testsrc2=size=352x288:rate=25:duration=2", "-c:v", "libx265", "-x265-params", "log-level=error:keyint=10:bframes=2", "-f", "hevc", f"{OUT}/stream.265")
ff("-f", "lavfi", "-i", "testsrc2=size=352x288:rate=25:duration=2", "-c:v", "libx264", "-bf", "0", "-g", "25", "-f", "h264", f"{OUT}/nob.264")
ff(*SRC, "-c:v", "mjpeg", "-q:v", "4", f"{OUT}/mjpeg.avi")
ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=1", "-c:v", "rawvideo", "-pix_fmt", "bgr24", f"{OUT}/bgr24.avi")
ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=1", "-c:v", "rawvideo", "-pix_fmt", "yuyv422", f"{OUT}/yuy2.avi")
ff("-f", "lavfi", "-i", "testsrc2=size=352x288:rate=25:duration=2", "-c:v", "libx264", "-bf", "0", "-g", "25", f"{OUT}/h264.avi")
ff("-f", "lavfi", "-i", "testsrc2=size=352x288:rate=25:duration=1", "-c:v", "libxvid", f"{OUT}/xvid.avi")
ff("-f", "lavfi", "-i", "testsrc2=size=352x288:rate=25:duration=2", "-c:v", "libx264", "-bf", "0", "-g", "25", "-f", "mpeg", f"{OUT}/ps_h264.mpg")
for i in range(10):
    ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=1:duration=1", "-vf", f"drawbox=x={i*28}:y=100:w=30:h=30:color=red@1:t=fill", "-frames:v", "1", f"{OUT}/seq/frame_{i}.png")
# Dahua DHAV container around H.264 access units
data = open(f"{OUT}/nob.264", "rb").read()
starts = [m.start() for m in re.finditer(b"\x00\x00\x00\x01", data)]
nals = [data[s:(starts[i + 1] if i + 1 < len(starts) else len(data))] for i, s in enumerate(starts)]
aus, cur = [], b""
for n in nals:
    t = n[4] & 0x1F
    if t in (7, 9) and cur: aus.append(cur); cur = b""
    cur += n
    if t in (1, 5): aus.append(cur); cur = b""
out = io.BytesIO(); out.write(b"\x00" * 16)
for i, au in enumerate(aus):
    key = b"\x00\x00\x00\x01\x65" in au
    ext = bytes([0x80, 0, 0, 0, 0x81, 0, 0, 0]); total = 24 + len(ext) + len(au) + 8
    out.write(b"DHAV" + bytes([0xFD if key else 0xFC, 0, 0, 0]) + struct.pack("<II", i, total) + struct.pack("<IH", 0x5A3C1234, i * 40) + bytes([len(ext), 0]) + ext + au + b"dhav" + struct.pack("<I", total))
open(f"{OUT}/dahua_sample.dav", "wb").write(out.getvalue())
ps = open(f"{OUT}/ps_h264.mpg", "rb").read()
open(f"{OUT}/hik_sample.mp4", "wb").write(b"IMKH" + b"\x01\x02" + b"\x00" * 34 + ps)
# MJPEG AVI with the Huffman tables stripped from every frame ("AVI1" style)
riff = open(f"{OUT}/mjpeg.avi", "rb").read()
def strip_dht(j):
    o, p = bytearray(j[:2]), 2
    while p + 4 <= len(j) and j[p] == 0xFF:
        m, ln = j[p + 1], (j[p + 2] << 8) | j[p + 3]
        if m == 0xDA: return bytes(o + j[p:])
        if m != 0xC4: o += j[p:p + 2 + ln]
        p += 2 + ln
    return j
i = riff.find(b"movi"); hdr = riff[:i - 8]; idx = riff.find(b"idx1"); p = i + 4; chunks = []
while p + 8 <= idx:
    cid, sz = riff[p:p + 4], struct.unpack("<I", riff[p + 4:p + 8])[0]; body = riff[p + 8:p + 8 + sz]
    chunks.append((cid, strip_dht(body) if cid == b"00dc" else body)); p += 8 + sz + (sz & 1)
movi = b"movi" + b"".join(c + struct.pack("<I", len(b)) + b + (b"\x00" if len(b) & 1 else b"") for c, b in chunks)
body = hdr[12:] + b"LIST" + struct.pack("<I", len(movi)) + movi
open(f"{OUT}/mjpeg_nodht.avi", "wb").write(b"RIFF" + struct.pack("<I", len(body) + 4) + b"AVI " + body)
img = Image.new("RGB", (800, 600), (40, 60, 90)); d = ImageDraw.Draw(img)
for k in range(0, 800, 40): d.line([(k, 0), (800 - k, 600)], fill=(200, 180, 40), width=2)
exif = Image.Exif(); exif[0x010F] = "ForensicCam"; exif[0x0110] = "FC-2000"; exif[0x0132] = "2026:03:14 09:26:53"
gps = exif.get_ifd(0x8825); gps[1] = "N"; gps[2] = (29.0, 42.0, 11.5); gps[3] = "W"; gps[4] = (98.0, 7.0, 30.2)
img.save(f"{OUT}/photo_exif.jpg", quality=88, exif=exif)
pages = [Image.new("RGB", (320, 240), c) for c in [(200, 30, 30), (30, 200, 30), (30, 30, 200)]]
pages[0].save(f"{OUT}/multipage.tif", save_all=True, append_images=pages[1:], compression="tiff_lzw")
# lossless input for the cross-browser filter reproducibility check (decodes identically in every engine)
ff("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=1:duration=1", "-vf", "noise=alls=10:allf=t,format=rgb24", "-frames:v", "1", f"{OUT}/repro.png")
print("media written to", OUT)
