# Lattice / Slides

[简体中文](README.zh-CN.md)

Lattice is the native deck renderer, presentation workbench and authoring engine used by the Praxis Slides app. It opens with an empty deck registry. The CLI and runtime retain their respective package metadata and notices. Real presentations, recordings, rendered media, caches and operator configuration belong in private storage.

Use Node 22.16 or later. Run `npm ci --ignore-scripts` and `npm run dev` to start the native workbench at http://localhost:4666/. Use `npm run build` for the standalone and managed browser bundles, then `npm start` to serve both and `npm test` for the synthetic release checks. Live rendering helpers may require their own browser, video engine or operator-provided model.

The native app supports a scoped business service (`npm run business`) with an operator-owned data root and signing key. Praxis forwards authenticated requests for a managed deck; grant and storage configuration are separate from this source. See [requirements](docs/Slides-Platform_PRD.md) and [roadmap](docs/ROADMAP.md).
