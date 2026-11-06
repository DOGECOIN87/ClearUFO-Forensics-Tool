// Every filter implementation of the native app, keyed by the filter id of the shared catalog.
// The implementations are the ports of the browser reference (src/engine/filters), so the ids, the
// parameters and the results are the same.
import { basicFilters } from "./basic";
import { linkFilters } from "./link";
import { presentationFilters } from "./presentation";
import { temporalFilters } from "./temporal";
import type { FilterImpl } from "../stream";

export const FILTERS_IMPL: Record<string, FilterImpl> = {
  ...basicFilters,
  ...linkFilters,
  ...temporalFilters,
  ...presentationFilters,
};

/** Ids of the filters this build can execute. */
export const IMPLEMENTED_IDS = Object.keys(FILTERS_IMPL);
