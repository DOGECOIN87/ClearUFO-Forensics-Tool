// Renders every processing filter once. Options (window.__allFiltersOpts):
//   fromChain0: use the loader of the first chain (e.g. a PNG file) as input instead of the test pattern
//   hash: return the MD5 of each output instead of its size;  frame: frame to render (default 2)
(async () => {
  const opts = window.__allFiltersOpts || {};
  const { FILTER_LIST, defaultParams } = await import("/src/shared/filters.ts");
  const e = window.lucid.engine;
  const tp = FILTER_LIST.find((f) => f.id === "test_pattern");
  const loader = opts.fromChain0 ? window.lucid.store.project.chains[0].filters[0] : null;
  const base = (id) => (loader ? { ...structuredClone(loader), id: "L" + id } : { id: "L" + id, type: "test_pattern", params: { ...defaultParams(tp), width: 320, height: 180, frames: 8, seed: 3 }, enabled: true });
  const other = { id: "other", name: "Other", filters: [loader ? { ...structuredClone(loader), id: "Lother" } : { id: "Lother", type: "test_pattern", params: { ...defaultParams(tp), pattern: "bars", width: 320, height: 180, frames: 8 }, enabled: true }] };
  const special = { crop: { rect: { x: 40, y: 20, w: 200, h: 120 } }, hide_selection: { rect: { x: 100, y: 60, w: 80, h: 50 } }, spotlight: { rect: { x: 100, y: 60, w: 80, h: 50 } }, magnify: { rect: { x: 120, y: 70, w: 60, h: 40 } }, local_stabilization: { roi: { x: 110, y: 70, w: 100, h: 50 } }, correct_perspective: { points: [{ x: 50, y: 40 }, { x: 270, y: 50 }, { x: 260, y: 150 }, { x: 60, y: 140 }] }, nonlinear_deblurring: { points: [{ x: 10, y: 10 }, { x: 16, y: 12 }, { x: 20, y: 18 }] }, measure_1d: { refLine: [{ x: 10, y: 10 }, { x: 110, y: 10 }], line: [{ x: 20, y: 50 }, { x: 200, y: 90 }] }, measure_2d: { refPoints: [{ x: 50, y: 40 }, { x: 270, y: 50 }, { x: 260, y: 150 }, { x: 60, y: 140 }], line: [{ x: 60, y: 60 }, { x: 200, y: 120 }] }, add_shape: { rect: { x: 50, y: 50, w: 100, h: 60 } }, video_mixer: { second: "other" }, picture_in_picture: { inset: "other" }, multiview: { chains: ["other"] }, timeline: { chains: ["other"] }, replace_channel: { source: "other" }, white_balance: { mode: "point", point: { x: 160, y: 90 } }, fourier_filter: { view: "filtered", points: [{ x: 200, y: 100 }] }, super_resolution: { maxFrames: 4 }, nl_means: { search: 3 }, sparse_selector: { frames: "0, 2-4" } };
  const skip = new Set(["image_loader", "video_loader", "sequence_loader", "test_pattern", "video_writer", "image_writer", "add_logo"]);
  const res = {};
  for (const f of FILTER_LIST) {
    if (skip.has(f.id)) continue;
    const chain = { id: "c_" + f.id, name: f.name, filters: [base(f.id), { id: "F" + f.id, type: f.id, params: { ...defaultParams(f), ...(special[f.id] || {}) }, enabled: true }] };
    await e.call("setProject", [chain, other]);
    const r = await e.call("render", { chainId: chain.id, filterId: null, frame: opts.frame ?? 2, channel: "stress", ...(opts.hash ? { want: { hash: true } } : {}) });
    res[f.id] = r.ok ? (opts.hash ? r.md5 : `${r.width}x${r.height}`) : "ERR: " + r.error;
  }
  window.lucid.store.syncEngine();
  return res;
})()
