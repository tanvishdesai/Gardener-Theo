import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { GardenApi } from "../../shared/types";
import { applyAppearance, cachedAppearance } from "./a11y";
import { App } from "./App";
import { createDemo } from "./demo";
import { connect } from "./store";
import "@fontsource/pixelify-sans/400.css";
import "@fontsource/pixelify-sans/600.css";
import "@fontsource/silkscreen/400.css";
import "@fontsource/vt323/400.css";
import "./styles.css";

declare global {
  interface Window {
    terrarium?: GardenApi;
  }
}

// Theme, text size and motion from last time, so the first paint matches before the snapshot arrives.
applyAppearance(cachedAppearance());

// In the desktop app the preload script provides the real garden; in a plain browser we simulate one.
const real = window.terrarium;
void connect(real ?? createDemo(), !real);

// Animations cost GPU time; nobody is watching a hidden window.
document.addEventListener("visibilitychange", () => {
  document.documentElement.classList.toggle("paused", document.hidden);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
