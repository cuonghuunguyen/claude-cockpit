import { defineConfig } from "tsup";

/**
 * Production build for the daemon (Task Scheduler / systemd `ExecStart`
 * eventually points at `dist/main.js` — see 02.1-RESEARCH.md "Recommended
 * Project Structure").
 *
 * `better-sqlite3` ships a native `.node` binary loaded via `require()` at
 * runtime — it must stay external (never bundled) so Node resolves the
 * prebuilt binary from `node_modules` normally.
 */
export default defineConfig({
  entry: ["src/main.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node24",
  platform: "node",
  clean: true,
  sourcemap: true,
  splitting: false,
  external: ["better-sqlite3"],
  noExternal: [],
});
