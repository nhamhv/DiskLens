import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import App from "./App";
import { loadPlatform } from "@/lib/platform";
import { api } from "@/lib/api";
import "./index.css";

// Errors thrown in the UI go to the crash folder next to Rust panics (see diagnostics.rs).
const logError = (message: string, stack = "") => {
  if (!message.startsWith("ResizeObserver")) api.logUiError(message, stack).catch(() => {});
};
window.addEventListener("error", (e) => logError(e.message, e.error?.stack ?? `${e.filename}:${e.lineno}:${e.colno}`));
window.addEventListener("unhandledrejection", (e) => logError(String(e.reason?.message ?? e.reason), e.reason?.stack ?? ""));

// Features differ per OS; know which before drawing anything. A failure keeps the defaults.
loadPlatform()
  .catch(() => {})
  .finally(() =>
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    ),
  );
