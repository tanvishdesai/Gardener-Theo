// You. A small gardener who walks over to whatever you are tending.
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "../motion";

const WALK_MS = 900;

export function Gardener({ x, y }: { x: number; y: number }) {
  const reduced = useReducedMotion();
  const prev = useRef({ x, y });
  const [walking, setWalking] = useState(false);
  const [facing, setFacing] = useState<1 | -1>(1);

  useEffect(() => {
    const dx = x - prev.current.x;
    const dy = y - prev.current.y;
    prev.current = { x, y };
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    if (Math.abs(dx) > 2) setFacing(dx > 0 ? 1 : -1);
    if (reduced) return;
    setWalking(true);
    const t = setTimeout(() => setWalking(false), WALK_MS);
    return () => clearTimeout(t);
  }, [x, y, reduced]);

  return (
    <div
      className={`gardener ${walking ? "gardener--walking" : ""}`}
      style={{ transform: `translate(${x - 26}px, ${y - 78}px)`, transitionDuration: reduced ? "0ms" : `${WALK_MS}ms` }}
      aria-hidden
    >
      <svg width="52" height="80" viewBox="-26 -78 52 80" style={{ transform: `scaleX(${facing})` }}>
        <ellipse cx={0} cy={0} rx={16} ry={3.5} fill="rgba(0,0,0,.18)" />
        <g className="gardener__legs">
          <rect className="leg leg--l" x={-7} y={-22} width={6} height={21} rx={3} fill="#4a5a7a" />
          <rect className="leg leg--r" x={1} y={-22} width={6} height={21} rx={3} fill="#3f4e6c" />
        </g>
        <g className="gardener__body">
          <path d="M-12,-44 C-12,-52 12,-52 12,-44 L11,-20 H-11Z" fill="#e9e1cf" />
          <path d="M-9,-42 H9 L10,-20 H-10Z" fill="#5f9a5a" />
          <rect x={-6} y={-36} width={12} height={8} rx={1.5} fill="#4f8650" />
          <path d="M-8,-46 L-6,-40 M8,-46 L6,-40" stroke="#4f8650" strokeWidth={2} />
          {/* arm with a little trowel */}
          <g className="gardener__arm">
            <path d="M10,-42 C16,-36 17,-30 15,-26" stroke="#e9e1cf" strokeWidth={5} strokeLinecap="round" fill="none" />
            <circle cx={15} cy={-25} r={2.8} fill="#e8b98f" />
            <path d="M15,-24 L18,-14 L14,-13Z" fill="#9aa5ad" />
          </g>
          <path d="M-10,-42 C-15,-36 -16,-30 -14,-26" stroke="#e9e1cf" strokeWidth={5} strokeLinecap="round" fill="none" />
          <circle cx={-14} cy={-25} r={2.8} fill="#e8b98f" />
          {/* head and straw hat */}
          <circle cx={0} cy={-56} r={8.5} fill="#e8b98f" />
          <circle cx={3} cy={-57} r={1.1} fill="#3b2a1e" />
          <path d="M2,-52.5 q2,1.2 4,0" stroke="#a5644a" strokeWidth={1} fill="none" />
          <ellipse cx={0} cy={-62} rx={16} ry={3.6} fill="#e3c06a" />
          <path d="M-8,-62 C-8,-72 8,-72 8,-62Z" fill="#edcf7f" />
          <rect x={-8} y={-64.5} width={16} height={2.6} fill="#c9584a" />
        </g>
      </svg>
    </div>
  );
}
