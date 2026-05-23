import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { workerFactory } from "./utils/workerFactory";
import App from "./App";
import "./index.css";
import {
  applyColorScheme,
  initialColorScheme,
  isAppColorScheme,
  watchSystemColorScheme,
} from "./lib/colorScheme";

async function applyBackendColorScheme() {
  try {
    const response = await fetch("/api/config", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return;

    const config = (await response.json()) as { colorScheme?: unknown };
    if (isAppColorScheme(config.colorScheme)) {
      applyColorScheme(config.colorScheme);
    }
  } catch {
    // The landing page also works as static HTML in development.
  }
}

applyColorScheme(initialColorScheme());
void applyBackendColorScheme();
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
