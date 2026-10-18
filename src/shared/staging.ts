// Names shared by the engine (which writes staging files) and the app (which downloads and removes them).
//
// Staging: where the browser cannot write to a file the user picks (Firefox, Safari, Chrome on Android,
// pages shown inside another site), large exports and live recordings are written to the browser's own
// storage for the site (the Origin Private File System, on disk, not in memory) and downloaded from there.

/** Directory of the staging files in the Origin Private File System. */
export const STAGING_DIR = "lucid-staging";

/** Web Lock held by the tab that owns a staging file, so other tabs never remove it while it is in use. */
export const STAGE_LOCK = "lucid-staged:";

/** Entry name: creation time (base 36), a random part and the file name, e.g. "mf3k2a1-x7q2-Case 12.avi". */
export function stagedEntryName(name: string, now = Date.now()): string {
  const safe = (name || "output").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").slice(-120);
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
}

/** Creation time encoded in an entry name, or null for names LUCID did not create. */
export function stagedEntryTime(entry: string): number | null {
  const m = /^([0-9a-z]{6,10})-[0-9a-z]{1,8}-/.exec(entry);
  if (!m) return null;
  const t = parseInt(m[1], 36);
  return Number.isFinite(t) && t > 1.5e12 && t < 4e12 ? t : null;
}
