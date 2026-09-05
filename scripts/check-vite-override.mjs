#!/usr/bin/env node
// Vite+ ships its Vite fork as `@voidzero-dev/vite-plus-core`, and `package.json`
// aliases `vite` to it through an override so that only one copy of the core is
// ever installed. Dependabot bumps `vite-plus` but cannot touch `overrides`, so
// the alias and the lockfile have to be refreshed by hand; this check fails when
// either of them drifts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const readJson = (name) => JSON.parse(readFileSync(new URL(name, root), "utf8"));

const pkg = readJson("package.json");
const lock = readJson("package-lock.json");

const CORE = "@voidzero-dev/vite-plus-core";
const errors = [];

const vitePlus = pkg.devDependencies?.["vite-plus"];
const override = pkg.overrides?.vite;

if (!vitePlus) {
  errors.push("package.json has no `vite-plus` devDependency.");
}
if (!override) {
  errors.push("package.json has no `overrides.vite` entry.");
}

if (vitePlus && override) {
  const prefix = `npm:${CORE}@`;
  if (!override.startsWith(prefix)) {
    errors.push(`overrides.vite should alias ${CORE}, but is "${override}".`);
  } else {
    const overrideVersion = override.slice(prefix.length);
    const wanted = vitePlus.replace(/^[\^~]/, "");
    if (overrideVersion !== wanted) {
      errors.push(
        `overrides.vite pins ${CORE}@${overrideVersion} but vite-plus is ${vitePlus}. ` +
          `Update the override to "npm:${CORE}@${wanted}" and re-run \`vp install\`.`,
      );
    }

    const locked = lock.packages?.["node_modules/vite"];
    if (!locked) {
      errors.push("package-lock.json has no `node_modules/vite` entry.");
    } else if (locked.name !== CORE || locked.version !== overrideVersion) {
      errors.push(
        `package-lock.json resolves node_modules/vite to ${locked.name ?? "vite"}@${locked.version} ` +
          `but overrides.vite pins ${CORE}@${overrideVersion}. Run \`vp install\` and commit package-lock.json.`,
      );
    }
  }
}

const installed = new Set();
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  const name = entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  if (name === CORE && entry.version) {
    installed.add(entry.version);
  }
}
if (installed.size > 1) {
  errors.push(
    `package-lock.json installs ${installed.size} copies of ${CORE}: ${[...installed].sort((a, b) => a.localeCompare(b)).join(", ")}.`,
  );
}

if (errors.length > 0) {
  console.error(`${fileURLToPath(new URL("check-vite-override.mjs", import.meta.url))} failed:`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`Vite+ toolchain versions are consistent (${CORE}@${[...installed][0]}).`);
