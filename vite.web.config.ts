// Runs the renderer alone in a browser with a simulated garden (no Electron, no Claude).
// `npm run build:web` emits a static site to dist-web/ for Vercel / Cloudflare Pages.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/renderer",
  plugins: [react()],
  server: { port: 5199 },
  build: { outDir: "../../dist-web", emptyOutDir: true },
});
