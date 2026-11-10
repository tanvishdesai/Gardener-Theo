// Runs the renderer alone in a browser with a simulated garden (no Electron, no Claude).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/renderer",
  plugins: [react()],
  server: { port: 5199 },
});
