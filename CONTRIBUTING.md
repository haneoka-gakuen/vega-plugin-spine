# Contributing

Use Node.js 20 or newer and pnpm 11. Run `pnpm check` before opening a change.
Keep adapters renderer-neutral and cancellation-safe, and add tests for every
lifecycle, descriptor, or animation-queue change.

This repository must remain code-only. Do not commit or generate Spine runtime
code or binaries, editor components, skeletons, atlases, textures, project
data, extracted game content, or credentials.

Maintainers publish from GitHub releases through npm trusted publishing. The
npm package must authorize this repository's `.github/workflows/publish.yml`
workflow before the first release.
