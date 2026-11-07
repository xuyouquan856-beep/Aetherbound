import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import {
  installReaderOpenTraceDebugTarget,
  readerOpenTraces,
} from "./features/reader/reader-open-trace.js";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/scan.css";
import "./styles/quotes.css";
import "./styles/library-constellation.css";
import "./styles/library-workspace.css";
import "./styles/library-effects.css";
import "./styles/window-home.css";
import "./styles/interactions.css";
import "./styles/crystal-collections.css";

installReaderOpenTraceDebugTarget(
  window as unknown as Record<string, unknown>,
  readerOpenTraces,
  import.meta.env.DEV
    || import.meta.env.MODE === "test"
    || import.meta.env.VITE_READER_TIMING === "1",
);

createRoot(document.getElementById("root")!).render(<StrictMode><div className="window-titlebar"><span>Aetherbound</span></div><App /></StrictMode>);
