# Virtual Aquarium Test

The canonical minimal RSG SDK app — the scaffold produced by `npx rk create`.

## Intent

A reference for the smallest correct app setup: one anchor node (`AquariumScene`) rendering a centered title/subtitle, registered in `index.ts`, mounted under the compiled `BaseAppScene`. Use it as the starting point for new apps and as a baseline of "correct project structure" (`roku-config.ts`, `tsconfig.json`, `src/`, compiled components).

## What it covers

- Minimal anchor node returning static SceneGraph layout (`LayoutGroup` + `Label`)
- The standard `main()` → `registerAnchorNode()` bootstrap in `index.ts`
- Canonical project/config layout for a new RSG app

## Development

```bash
npx rk dev          # Build + deploy to Roku device
pnpm test           # Run tests
pnpm run lint       # Lint sources
```
