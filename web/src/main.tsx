import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { workerFactory } from "./utils/workerFactory";
import App from "./App";
import "./index.css";
import { applyColorScheme, initialColorScheme, watchSystemColorScheme } from "./lib/colorScheme";

applyColorScheme(initialColorScheme());
watchSystemColorScheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkerPoolContextProvider
      poolOptions={{ workerFactory }}
      highlighterOptions={{
        theme: { dark: "pierre-dark", light: "pierre-light" },
      }}
    >
      <App />
    </WorkerPoolContextProvider>
  </StrictMode>,
);
