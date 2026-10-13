// The one refusal every packaged-app command gives off macOS.
//
// Its own module because four runtimes need the same words and none of them may pull in the
// others: `scripts/install-app.mjs` (bundled into the updater-owned clone),
// `scripts/require-macos.mjs` (the `npm run package` and `prerecover:database` guard),
// `scripts/recover-database.mjs`, and the updater in Electron main. `scripts/install.sh` runs
// before any checkout exists, so it carries a copy, and `test/macos-only.test.ts` holds the
// copy to this text.
//
// The packaged app, its updater and its database recovery are macOS only. Linux runs from a
// source checkout (docs/setup.md), so every command that only makes sense for the `.app`
// refuses before it starts work, rather than failing partway through a build.

export const MACOS_ONLY_MESSAGE =
  "The packaged app is macOS only; on Linux run from a checkout (see docs/setup.md).";

/** The refusal for a packaged-app command on `platform`, or null on macOS. */
export function macOSOnlyRefusal(platform) {
  return platform === "darwin" ? null : MACOS_ONLY_MESSAGE;
}
