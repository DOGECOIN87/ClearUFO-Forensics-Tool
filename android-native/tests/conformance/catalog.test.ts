// Conformance: the filter catalog and the project file against the browser reference.
//
// The catalog is the contract between the app and the saved project files: the same filter ids, the
// same parameters and the same defaults have to exist in the app, otherwise a case saved on the
// workstation could not be opened on the phone.
import { describe, expect, it } from "vitest";

import { CATEGORIES as refCategories, FILTER_LIST as refList, FILTERS as refFilters, defaultParams as refDefaults } from "../../../src/shared/filters";
import { PROJECT_SCHEMA as refSchema, migrateProject as refMigrate, validateProject as refValidate } from "../../../src/shared/project";

import { CATEGORIES, FILTER_LIST, FILTERS, defaultParams } from "@/lib/shared/filters";
import { PROJECT_SCHEMA, migrateProject, validateProject } from "@/lib/shared/project";

describe("filter catalog", () => {
  it("has the same categories", () => {
    expect(CATEGORIES).toEqual(refCategories);
  });

  it("has the same filters", () => {
    expect(FILTER_LIST.map((f) => f.id)).toEqual(refList.map((f) => f.id));
  });

  it("has the same definitions, parameters and defaults", () => {
    for (const ref of refList) {
      const nat = FILTERS[ref.id];
      expect(nat, `filter ${ref.id} is missing`).toBeTruthy();
      expect(nat.name, `${ref.id}: name`).toBe(ref.name);
      expect(nat.category, `${ref.id}: category`).toBe(ref.category);
      expect(nat.kind, `${ref.id}: kind`).toBe(ref.kind);
      expect(nat.description, `${ref.id}: description`).toBe(ref.description);
      expect(nat.params.map((p) => p.key), `${ref.id}: parameters`).toEqual(ref.params.map((p) => p.key));
      expect(defaultParams(nat), `${ref.id}: defaults`).toEqual(refDefaults(ref));
    }
  });
});

describe("project files", () => {
  it("uses the same schema number", () => {
    expect(PROJECT_SCHEMA).toBe(refSchema);
  });

  it("migrates old files the same way", () => {
    const old = {
      schema: 1,
      chains: [{ id: "c1", filters: [{ type: "grayscale", params: { method: "bt601" } }] }],
    };
    const a = structuredClone(old);
    const b = structuredClone(old);
    expect(migrateProject(a)).toBe(refMigrate(b));
    expect(a).toEqual(b);
    expect((a as { schema: number }).schema).toBe(refSchema);
  });

  it("validates the same way", () => {
    const good = { schema: PROJECT_SCHEMA, chains: [] };
    expect(validateProject(good)).toBe(refValidate(structuredClone(good)));
    expect(validateProject(good)).toBeNull();
    const bad = { schema: PROJECT_SCHEMA, chains: [{ id: "c1" }] };
    expect(validateProject(bad)).toBe(refValidate(structuredClone(bad)));
    expect(validateProject(bad)).not.toBeNull();
  });
});
