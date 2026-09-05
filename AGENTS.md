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
