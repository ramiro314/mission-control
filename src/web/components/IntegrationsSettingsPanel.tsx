import { useState } from "react";
import { Tooltip } from "./Tooltip.tsx";

type Outcome = { ok: boolean; message: string };

/**
 * The desktop shell's Claude integrations, reachable without a tray.
 *
 * The tray menu was the only way in, and a desktop with no StatusNotifier host (stock GNOME)
 * has no tray, so the Setup row and the hook warning that say "press Install Claude
 * integrations" had nothing to press. The shell also reports each result in its own dialog;
 * the line here outlives that dialog. A browser has no bridge to call, so this renders nothing.
 */
export function IntegrationsSettingsPanel(): React.JSX.Element | null {
  const desktop = typeof window === "undefined" ? undefined : window.missionDesktop;
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  if (!desktop?.isDesktop) return null;
  const run = async (action: () => Promise<Outcome>) => {
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(await action());
    } catch (error) {
      setOutcome({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-section" aria-label="Integrations">
      <div className="settings-section-head"><h3>Integrations</h3></div>
      <p className="settings-hint">
        Wire Claude Code&apos;s status hooks and the Mission Control MCP server to this app. Start a
        new Claude Code session afterwards for the hooks to take effect.
      </p>
      <div className="integrations-actions">
        <Tooltip label="Install the status hooks and register the MCP server for Claude Code.">
          <button type="button" className="btn" disabled={busy}
            onClick={() => { void run(() => desktop.installIntegrations()); }}>Install Claude integrations</button>
        </Tooltip>
        <Tooltip label="Remove the hooks, the MCP registration and the cost telemetry settings this app added.">
          <button type="button" className="btn btn-ghost" disabled={busy}
            onClick={() => { void run(() => desktop.removeIntegrations()); }}>Remove Claude integrations</button>
        </Tooltip>
      </div>
      {outcome && (outcome.ok
        ? <p className="settings-hint" role="status">{outcome.message}</p>
        : <p className="settings-warn" role="alert">{outcome.message}</p>)}
    </section>
  );
}
