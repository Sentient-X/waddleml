/* The one runtime seam onto ECharts. It `import()`s echarts lazily on mount so
   the ~1MB library lands in its own chunk — the runs/compare pages (uPlot) and
   the rest of the console never pay for it. A single instance is created per
   mount, re-`setOption`'d on option changes, resized with a ResizeObserver, and
   disposed on unmount. The option itself is built ahead of time in charts.ts;
   this file knows nothing about report props. */

import { useEffect, useRef, useState } from "react";
import type { EChartsOption, EChartsType } from "echarts";

export function EChart({ option, height = 240 }: { option: EChartsOption; height?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const optionRef = useRef<EChartsOption>(option);
  const [ready, setReady] = useState(false);
  optionRef.current = option;

  // Init once: dynamic-import echarts (own chunk), create the instance, wire a
  // resize observer. The whole effect is guarded against unmount-before-load.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;
    let observer: ResizeObserver | null = null;

    void import("echarts").then((echarts) => {
      if (disposed || !containerRef.current) return;
      const chart = echarts.init(containerRef.current, undefined, { renderer: "canvas" });
      chart.setOption(optionRef.current);
      chartRef.current = chart;
      observer = new ResizeObserver(() => chart.resize());
      observer.observe(containerRef.current);
      setReady(true);
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  // Re-apply the option on change. `notMerge` clears stale series when the shape
  // (series count, axis kind) changes between renders.
  useEffect(() => {
    if (!ready) return;
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option, ready]);

  return <div ref={containerRef} className="w-full" style={{ height }} />;
}
