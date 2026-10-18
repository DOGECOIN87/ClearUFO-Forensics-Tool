// Web Worker entry of the processing engine. Bundled to a self-contained script by the
// "virtual:engine-code" plugin (vite.config.ts), which also lets the page run it in place.
// The same script serves as kernel worker of the multi-core pool (pool.ts), selected by the worker name.
import { serveEngine, type EnginePort } from "./rpc";
import { KERNEL_WORKER_NAME, serveKernels } from "./pool";

if ((self as unknown as { name?: string }).name === KERNEL_WORKER_NAME) serveKernels(self as unknown as EnginePort);
else serveEngine(self as unknown as EnginePort);
