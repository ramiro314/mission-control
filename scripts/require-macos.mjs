#!/usr/bin/env node
// Refuse a packaged-app command off macOS before it starts work. `npm run package` and the
// `prerecover:database` hook run this first, so `make app`, `make install-app` and database
// recovery stop here instead of after a build.
import { macOSOnlyRefusal } from "../src/shared/macos-only.mjs";

const refusal = macOSOnlyRefusal(process.platform);
if (refusal) {
  console.error(refusal);
  process.exitCode = 1;
}
