import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import App from "./App";
import { loadPlatform } from "@/lib/platform";
import "./index.css";

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
