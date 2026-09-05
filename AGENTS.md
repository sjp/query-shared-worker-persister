<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

## Validating changes

`vp check` (also `npm run check`, and `npm run check:fix` to apply fixes) formats, lints and
type checks in one pass. CI runs it via `vp run check`, so formatting drift and lint or type
errors fail the build.

The `build` script keeps its own `tsc` step in front of `vp pack`. `vp pack` emits
declarations without checking them, so without that step a local `npm run build` would
happily produce a package from code that does not type check. CI therefore type checks twice,
once in `check` and once in `build`; the second pass costs little and keeps `npm run build`
trustworthy on its own.

## Tests

`vp test` runs two suites. The Node suite is the bulk of it: it drives the client and the
worker through fake ports, which is where behaviour like timeouts, disposal and malformed
messages can be provoked directly.

The browser suite (`src/**/*.browser.test.ts`) runs in headless Chromium through Vitest's
Playwright provider and covers only what a fake port cannot show — one worker process behind
two connections, and the `(scriptURL, name)` pair that decides which tabs share a store. It
loads the package from `dist/`, so the packaging contract is covered too: `npm run build`
first, or the suite fails saying so. Install the browser once with `npm run playwright:install`.

## Upgrading Vite+

`package.json` aliases `vite` to Vite+'s own fork of it:

```json
"overrides": { "vite": "npm:@voidzero-dev/vite-plus-core@<version>" }
```

The alias exists so that a single copy of the core is installed. Dependabot can bump
`devDependencies.vite-plus`, but it cannot touch `overrides`, so a Vite+ upgrade is only
complete once all three of these agree:

1. `devDependencies.vite-plus`,
2. the version in `overrides.vite`, and
3. the `node_modules/vite` entry in `package-lock.json`.

Prefer `vp migrate`, which re-pins `vite-plus` and the alias together. Otherwise edit the
override by hand, then run `vp install` (not `--frozen-lockfile`) and commit the refreshed
`package-lock.json`. `npm run check:toolchain` verifies all three and runs in CI.
