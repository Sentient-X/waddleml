/* The console's one chart theme. uPlot draws to a canvas and echarts wants
   concrete color strings, so neither can read the CSS custom properties — these
   fixed values are the single source both renderers use. Series colors are
   theme-neutral (they read on light and dark canvases alike); the axis/grid
   strokes are the muted-gray fallbacks the echarts theme resolves against. */

export const PALETTE = [
  "#2563eb",
  "#f97316",
  "#16a34a",
  "#db2777",
  "#9333ea",
  "#0891b2",
  "#ca8a04",
  "#dc2626",
] as const;

export const AXIS_STROKE = "#8a8f98";
export const GRID_STROKE = "rgba(128,128,128,0.16)";
