// The sky follows your local clock. Weather follows the garden: a wilted plant brings a cloud.
import { useEffect, useState } from "react";
import { useGarden } from "../store";

export type Phase = "dawn" | "day" | "dusk" | "night";

function phaseAt(d: Date): Phase {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h >= 5.5 && h < 8) return "dawn";
  if (h >= 8 && h < 17.5) return "day";
  if (h >= 17.5 && h < 20) return "dusk";
  return "night";
}

export function usePhase(): Phase {
  const forced = typeof location !== "undefined" ? (new URLSearchParams(location.search).get("phase") as Phase | null) : null;
  const [phase, setPhase] = useState<Phase>(() => forced ?? phaseAt(new Date()));
  useEffect(() => {
    if (forced) return;
    const t = setInterval(() => setPhase(phaseAt(new Date())), 60_000);
    return () => clearInterval(t);
  }, [forced]);
  return phase;
}

export function Sky({ phase }: { phase: Phase }) {
  const wilted = useGarden((s) => Object.values(s.plants).some((p) => p.status === "error"));
  const night = phase === "night";
  return (
    <div className="sky" aria-hidden>
      <svg className="sky__svg" viewBox="0 0 1440 260" preserveAspectRatio="xMidYMax slice">
        {night &&
          Array.from({ length: 40 }, (_, i) => (
            <circle key={i} cx={(i * 211) % 1440} cy={(i * 67) % 150} r={i % 5 === 0 ? 1.6 : 1} fill="#fff" opacity={0.4 + (i % 3) * 0.2} className={i % 4 === 0 ? "twinkle" : ""} />
          ))}
        {night ? (
          <g transform="translate(1180 70)">
            <circle r={26} fill="#f4f1de" />
            <circle cx={10} cy={-6} r={24} fill="var(--sky-top)" />
          </g>
        ) : (
          <g transform={`translate(${phase === "dawn" ? 220 : phase === "dusk" ? 1220 : 1160} ${phase === "day" ? 64 : 150})`}>
            <circle r={58} fill="#fff2b0" opacity={0.35} />
            <circle r={34} fill={phase === "day" ? "#ffe17a" : "#ffb36b"} />
          </g>
        )}
        <g className="clouds" opacity={night ? 0.25 : 0.9}>
          <Cloud x={160} y={60} s={1} />
          <Cloud x={620} y={36} s={0.7} />
          <Cloud x={940} y={90} s={0.85} />
        </g>
        {wilted && (
          <g className="raincloud">
            <Cloud x={420} y={70} s={1.1} dark />
            {[0, 1, 2, 3, 4].map((i) => (
              <line key={i} x1={400 + i * 18} y1={100} x2={396 + i * 18} y2={112} stroke="#7d93a8" strokeWidth={2} strokeLinecap="round" className="rain" style={{ animationDelay: `${i * 0.2}s` }} />
            ))}
          </g>
        )}
        <path d="M0,210 C180,150 360,170 520,190 C700,212 860,140 1040,160 C1200,178 1320,150 1440,170 L1440,260 L0,260Z" fill="var(--hill-far)" />
        <path d="M0,240 C220,196 420,214 640,226 C860,238 1060,196 1260,208 C1340,212 1400,220 1440,224 L1440,260 L0,260Z" fill="var(--hill-near)" />
        <Greenhouse x={96} y={212} />
        {[300, 340, 1300, 1340, 1380].map((x, i) => (
          <Tree key={x} x={x} y={i < 2 ? 216 : 214} s={i % 2 ? 0.8 : 1} />
        ))}
      </svg>
    </div>
  );
}

function Cloud({ x, y, s, dark }: { x: number; y: number; s: number; dark?: boolean }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`} fill={dark ? "#9aa7b4" : "#fff"}>
      <ellipse cx={0} cy={0} rx={46} ry={16} />
      <ellipse cx={-20} cy={-8} rx={22} ry={16} />
      <ellipse cx={16} cy={-14} rx={26} ry={20} />
    </g>
  );
}

function Tree({ x, y, s }: { x: number; y: number; s: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <rect x={-3} y={-18} width={6} height={20} fill="var(--trunk)" />
      <circle cx={0} cy={-34} r={20} fill="var(--tree)" />
      <circle cx={-10} cy={-26} r={13} fill="var(--tree-dark)" />
    </g>
  );
}

function Greenhouse({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`} className="greenhouse">
      <path d="M-50,0 V-40 L0,-74 L50,-40 V0Z" fill="var(--glass)" stroke="var(--glass-frame)" strokeWidth={2.4} />
      <path d="M-50,-40 H50 M0,-74 V0 M-25,-57 V0 M25,-57 V0" stroke="var(--glass-frame)" strokeWidth={1.6} />
      <rect x={-9} y={-26} width={18} height={26} fill="var(--glass-frame)" opacity={0.5} />
    </g>
  );
}
