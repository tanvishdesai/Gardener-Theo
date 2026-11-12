// Frame counters for the benchmark (scripts/bench.mjs). Only installed with `?perf=1`; otherwise free.
export interface TerrariumPerf {
  /** Milliseconds per drawn frame. */
  frames: number[];
  /** Frames drawn. */
  draws: number;
  /** fillRect + drawImage calls in the last drawn frame. */
  fills: number;
  reset(): void;
  /** Screen point (CSS px, relative to the garden) of some visible plant, for the bench to click. */
  visiblePlant?: () => { x: number; y: number; id: string } | null;
}

declare global {
  interface Window {
    __terrariumPerf?: TerrariumPerf;
  }
}

let calls = 0;

function install(): TerrariumPerf {
  const proto = CanvasRenderingContext2D.prototype;
  const fill = proto.fillRect;
  const draw = proto.drawImage;
  proto.fillRect = function (...a: Parameters<typeof fill>) {
    calls++;
    return fill.apply(this, a);
  };
  proto.drawImage = function (this: CanvasRenderingContext2D, ...a: unknown[]) {
    calls++;
    return (draw as (...x: unknown[]) => void).apply(this, a);
  } as typeof draw;
  const p: TerrariumPerf = {
    frames: [],
    draws: 0,
    fills: 0,
    reset() {
      p.frames = [];
      p.draws = 0;
    },
  };
  window.__terrariumPerf = p;
  return p;
}

const perf = typeof location !== "undefined" && /[?&]perf=1/.test(location.search) ? install() : null;

/** Wraps one frame's drawing. */
export function measured(fn: () => void) {
  if (!perf) return fn();
  calls = 0;
  const t = performance.now();
  fn();
  perf.frames.push(performance.now() - t);
  perf.draws++;
  perf.fills = calls;
}

export function perfHooks(): TerrariumPerf | null {
  return perf;
}
