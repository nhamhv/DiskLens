import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The Tauri window loads `devUrl`, so Vite must never silently switch ports (strictPort).
// `npm start` (scripts/dev.mjs) picks a free one and passes it to both via PORT.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  clearScreen: false,
  build: { chunkSizeWarningLimit: 1500 }, // desktop app: one local bundle is fine
  server: {
    port: Number(process.env.PORT) || 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
