/** Coordinate mapping for an aspect-fit image, scaled around the viewport centre. */
export interface Viewport { width: number; height: number; imageWidth: number; imageHeight: number; zoom: number; panX: number; panY: number }
export function imageBounds(v: Viewport) {
  const scale = Math.min(v.width / v.imageWidth, v.height / v.imageHeight) * v.zoom;
  const width = v.imageWidth * scale, height = v.imageHeight * scale;
  return { left: (v.width - width) / 2 + v.panX, top: (v.height - height) / 2 + v.panY, width, height, scale };
}
export function imagePixel(v: Viewport, x: number, y: number): { x: number; y: number } | null {
  if (v.width <= 0 || v.height <= 0 || v.imageWidth <= 0 || v.imageHeight <= 0 || v.zoom <= 0) return null;
  const b = imageBounds(v);
  const ix = Math.floor((x - b.left) / b.scale), iy = Math.floor((y - b.top) / b.scale);
  return ix >= 0 && iy >= 0 && ix < v.imageWidth && iy < v.imageHeight ? { x: ix, y: iy } : null;
}
/** Keep the image point beneath the initial pinch centre under the current centre. */
export function pinchPan(start: Viewport, startX: number, startY: number, x: number, y: number, zoom: number) {
  const ratio = zoom / start.zoom;
  return {
    panX: x - start.width / 2 - (startX - start.width / 2 - start.panX) * ratio,
    panY: y - start.height / 2 - (startY - start.height / 2 - start.panY) * ratio,
  };
}
