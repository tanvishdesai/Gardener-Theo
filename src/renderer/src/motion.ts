import { useSyncExternalStore } from "react";
import { useGarden } from "./store";

const query = typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

/** The Motion setting wins; "system" follows the OS preference. */
export function useReducedMotion(): boolean {
  const motion = useGarden((s) => s.settings.motion);
  const os = useSyncExternalStore(
    (cb) => {
      query?.addEventListener("change", cb);
      return () => query?.removeEventListener("change", cb);
    },
    () => query?.matches ?? false,
  );
  return motion === "reduce" || (motion !== "allow" && os);
}
