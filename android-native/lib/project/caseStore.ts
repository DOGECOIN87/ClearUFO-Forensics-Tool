// The local case storage.
//
// A case is the project document of the browser workbench (`.lfp`): the chains with their parameters,
// the sources with their hashes and the case information. The cases are kept in the storage of the
// device (AsyncStorage); nothing is written to the server of the project and nothing is uploaded.
import AsyncStorage from "@react-native-async-storage/async-storage";

import { PROJECT_SCHEMA, migrateProject, validateProject } from "@/lib/shared/project";
import type { ChainDoc, ProjectDoc, SourceRef } from "@/lib/shared/types";

const KEY = "clearufo.cases.v1";

export interface StoredCase {
  id: string;
  doc: ProjectDoc;
}

export async function listCases(): Promise<StoredCase[]> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c) => c && typeof c.id === "string" && c.doc);
  } catch {
    return [];
  }
}

async function writeCases(cases: StoredCase[]) {
  await AsyncStorage.setItem(KEY, JSON.stringify(cases));
}

export async function saveCase(doc: ProjectDoc, id?: string): Promise<string> {
  const cases = await listCases();
  const caseId = id ?? `case-${Date.now().toString(36)}`;
  const stored: StoredCase = { id: caseId, doc: { ...doc, modified: new Date().toISOString() } };
  const i = cases.findIndex((c) => c.id === caseId);
  if (i >= 0) cases[i] = stored;
  else cases.unshift(stored);
  await writeCases(cases.slice(0, 100));
  return caseId;
}

export async function deleteCase(id: string): Promise<void> {
  const cases = await listCases();
  await writeCases(cases.filter((c) => c.id !== id));
}

export async function readCase(id: string): Promise<StoredCase | null> {
  const cases = await listCases();
  return cases.find((c) => c.id === id) ?? null;
}

/** Builds the project document of the current session (the format of the browser workbench). */
export function buildProjectDoc(options: {
  name: string;
  chains: ChainDoc[];
  sources: Record<string, SourceRef>;
  caseInfo?: Partial<ProjectDoc["caseInfo"]>;
}): ProjectDoc {
  const now = new Date().toISOString();
  return {
    app: "ClearUFO Forensics",
    schema: PROJECT_SCHEMA,
    name: options.name,
    chains: options.chains,
    sources: options.sources,
    caseInfo: {
      caseNumber: options.caseInfo?.caseNumber ?? "",
      examiner: options.caseInfo?.examiner ?? "",
      agency: options.caseInfo?.agency ?? "",
      exhibit: options.caseInfo?.exhibit ?? "",
      notes: options.caseInfo?.notes ?? "",
    },
    bookmarks: [],
    created: now,
    modified: now,
  };
}

/** Checks a project document and brings it up to the current schema (without changing its results). */
export function inspectProject(doc: unknown): { error: string | null; pinned: number; doc: ProjectDoc | null } {
  const parsed = typeof doc === "string" ? (JSON.parse(doc) as ProjectDoc) : (doc as ProjectDoc);
  const error = validateProject(parsed);
  if (error) return { error, pinned: 0, doc: null };
  const pinned = migrateProject(parsed);
  return { error: null, pinned, doc: parsed };
}
