import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,

  // Multi-entry build (03-04-PLAN.md): the actionable decision toast
  // (NOT-02) is a second webview entry (`toast.html` -> `ToastWindow.tsx`),
  // built alongside the main dashboard entry (`index.html` -> `main.tsx`)
  // so `WebviewUrl::App("toast.html")` (`toast_window.rs`) resolves inside
  // `frontendDist` at runtime.
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        toast: path.resolve(__dirname, "toast.html"),
      },
    },
  },

  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
