import { installExperienceReporting } from "./lib/experience.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ManagedPlanReader } from "./components/ManagedPlanReader.tsx";
import { hydrateUiConfig } from "./lib/uiConfig.ts";
import { desktopPlatformClass } from "./lib/platform.ts";
import { ModelCatalogProvider } from "./model-catalog.tsx";
import "@xyflow/react/dist/style.css";
// Global vendor CSS belongs at the browser entry rather than inside `DiffView`: the latter is
// reached by reusable review cards, including server-rendered component tests, while this file
// is the one surface that actually boots the stylesheet-aware Vite application.
import "react-diff-view/style/index.css";
import "./styles.css";

// In the Electron shell on macOS the window has no native title bar, so the topbar
// doubles as it: `is-mac` turns on the traffic-light inset and the drag region. A Linux
// window has the window manager's frame (`is-linux`), and a plain browser tab gets none.
if (window.missionDesktop?.isDesktop) {
  document.documentElement.classList.add("is-desktop", desktopPlatformClass(window.missionDesktop));
}

// Reconcile the dashboard's preferences with the daemon, which owns them. Fired here
// rather than from an effect in App because it is not App's state: the layout, the
// keybindings, the alert toggles and the rich-text switch all read one module store, and
// three of those four are used outside the tree. The first paint has already happened
// from the local cache by the time this resolves, so there is nothing to wait for.
void hydrateUiConfig();

installExperienceReporting();

const root = document.getElementById("root");
const planQuery = new URLSearchParams(window.location.search);
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <ModelCatalogProvider>
      {planQuery.has("plan") ? <ManagedPlanReader id={planQuery.get("plan")!} revision={Number(planQuery.get("revision"))} /> : <App />}
    </ModelCatalogProvider>
  </StrictMode>,
);
