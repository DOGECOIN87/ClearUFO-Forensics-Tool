/// <reference types="vite/client" />

/** The processing engine bundled as one self-contained script (see the plugin in vite.config.ts). */
declare module "virtual:engine-code" {
  const code: string;
  export default code;
}
