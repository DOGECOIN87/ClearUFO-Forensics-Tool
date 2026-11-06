const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

export function base64ToBytes(input: string): Uint8Array {
  const compact = input.replace(/\s/g, "").replace(/=+$/, "");
  if (compact.length % 4 === 1) throw new Error("Invalid base64 data");
  const padded = compact + "=".repeat((4 - (compact.length % 4)) % 4);
  const size = Math.floor((padded.length * 3) / 4) - (padded.endsWith("==") ? 2 : padded.endsWith("=") ? 1 : 0);
  const out = new Uint8Array(size);
  let at = 0;

  for (let i = 0; i < padded.length; i += 4) {
    const values = [padded.charCodeAt(i), padded.charCodeAt(i + 1), padded.charCodeAt(i + 2), padded.charCodeAt(i + 3)].map((code) => {
      if (code === 61) return 0;
      const value = code < LOOKUP.length ? LOOKUP[code] : -1;
      if (value < 0) throw new Error("Invalid base64 character");
      return value;
    });
    const word = (values[0] << 18) | (values[1] << 12) | (values[2] << 6) | values[3];
    if (at < size) out[at++] = (word >>> 16) & 255;
    if (at < size) out[at++] = (word >>> 8) & 255;
    if (at < size) out[at++] = word & 255;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const hasB = i + 1 < bytes.length;
    const hasC = i + 2 < bytes.length;
    const b = hasB ? bytes[i + 1] : 0;
    const c = hasC ? bytes[i + 2] : 0;
    const word = (a << 16) | (b << 8) | c;
    out += ALPHABET[(word >>> 18) & 63];
    out += ALPHABET[(word >>> 12) & 63];
    out += hasB ? ALPHABET[(word >>> 6) & 63] : "=";
    out += hasC ? ALPHABET[word & 63] : "=";
  }
  return out;
}
