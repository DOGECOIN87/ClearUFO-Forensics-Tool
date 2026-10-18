// Project document helpers shared by the UI and the tests (no DOM dependencies).
import { FILTERS, type FilterDef, type ParamDef } from "./filters";

/**
 * Project schema written by this version.
 * 2: Video Loaders carry an explicit Chroma Filter (chroma upsampling; bicubic by default). Schema 1 projects decoded
 *    chroma by sample replication; older versions cannot honour the new option, so they refuse schema 2.
 * 3: Video Loaders carry an explicit HDR Video choice (HDR streams tone mapped to SDR by default). Schema 2 projects
 *    showed HDR signal values as decoded, and keep doing so (legacy value "none").
 */
export const PROJECT_SCHEMA = 3;

/**
 * Bring a project saved by an earlier version up to date WITHOUT changing its results: parameters added later
 * whose default differs from the old behaviour (ParamDef.legacy, e.g. Video Loader › Chroma Filter, which
 * earlier versions did by sample replication) are written with their legacy value. Returns how many filters
 * were pinned that way (the user may then choose the new default explicitly).
 */
export function migrateProject(doc: any): number {
  let pinned = 0;
  for (const c of Array.isArray(doc?.chains) ? doc.chains : []) {
    for (const f of Array.isArray(c?.filters) ? c.filters : []) {
      const def: FilterDef | undefined = f ? FILTERS[f.type] : undefined;
      const legacy: ParamDef[] = def ? def.params.filter((d) => d.legacy !== undefined) : [];
      if (!legacy.length) continue;
      if (!f.params || typeof f.params !== "object") f.params = {};
      let n = 0;
      for (const d of legacy) if (!(d.key in f.params)) { f.params[d.key] = structuredClone(d.legacy); n++; }
      if (n) pinned++;
    }
  }
  if (doc && typeof doc === "object") doc.schema = PROJECT_SCHEMA;
  return pinned;
}

/** Structural validation of a parsed project document. Returns a reason when it is not usable. */
export function validateProject(doc: any): string | null {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return "the file does not contain a project";
  if (!Array.isArray(doc.chains)) return typeof doc.app === "string" && doc.app ? `it was written by “${doc.app}” and has no filter chains` : "no filter chains were found";
  if (typeof doc.schema === "number" && doc.schema > PROJECT_SCHEMA) return `it was saved by a newer version (schema ${doc.schema})`;
  const unknown = new Set<string>();
  for (const [ci, c] of (doc.chains as any[]).entries()) {
    if (!c || typeof c.id !== "string" || !Array.isArray(c.filters) || !c.filters.length) return `chain ${ci + 1} is damaged`;
    for (const f of c.filters) {
      if (!f || typeof f.id !== "string" || typeof f.type !== "string" || (f.params != null && typeof f.params !== "object")) return `chain “${c.name ?? ci + 1}” contains a damaged filter`;
      if (!FILTERS[f.type]) unknown.add(f.type);
    }
  }
  if (unknown.size) return `it uses filters unknown to this version (${[...unknown].slice(0, 5).join(", ")})`;
  if (doc.sources != null && (typeof doc.sources !== "object" || Array.isArray(doc.sources))) return "the media source table is damaged";
  return null;
}
