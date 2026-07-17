import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

/**
 * Thin entry point: mounts the dashboard root component (`App.tsx`). The
 * live session-loading + `listen()`/`invoke()` wiring that used to live
 * directly in this file (Plan 01-02's Walking Skeleton) moved into
 * `App.tsx` in Plan 01-05, alongside the full queue-of-cards UI.
 */
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
