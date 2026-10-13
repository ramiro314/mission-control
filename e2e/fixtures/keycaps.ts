/**
 * A keycap as the dashboard prints it on the machine running the suite, written in its macOS
 * spelling. On macOS that is the argument itself; elsewhere `formatChord`
 * (`src/web/lib/keybindings.ts`) names the modifiers instead, Ctrl for both ⌘ and ⌃, in
 * Ctrl+Alt+Shift order: `platformKeycap("⌘⇧R")` is "Ctrl+Shift+R" on Linux.
 *
 * Specs that are about the keycaps themselves assert the Linux spelling literally
 * (`linux-primary-modifier.spec.ts`), so this is not the only thing that says what Linux reads.
 */
export function platformKeycap(mac: string): string {
  if (process.platform === "darwin") return mac;
  const [, glyphs = "", key = ""] = /^([⌘⌃⌥⇧]*)(.*)$/su.exec(mac) ?? [];
  const named = new Set([...glyphs].map((g) => MOD_NAME[g]));
  return [...["Ctrl", "Alt", "Shift"].filter((m) => named.has(m)), key].join("+");
}

const MOD_NAME: Record<string, string> = { "⌘": "Ctrl", "⌃": "Ctrl", "⌥": "Alt", "⇧": "Shift" };

/** `platformKeycap`, escaped for use inside a `RegExp`. */
export function platformKeycapPattern(mac: string): string {
  return platformKeycap(mac).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
