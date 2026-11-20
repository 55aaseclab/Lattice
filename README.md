# Lattice / Slides

[简体中文](README.zh-CN.md)

Lattice is the native deck renderer, presentation workbench and authoring engine used by the Praxis Slides app. It opens with an empty deck registry. The CLI and runtime retain their respective package metadata and notices. Real presentations, recordings, rendered media, caches and operator configuration belong in private storage.

Use Node 22.16 or later. Run `npm ci --ignore-scripts` and `npm run dev` to start the native workbench at http://localhost:4666/. Use `npm run build` for the standalone and managed browser bundles, then `npm start` to serve both and `npm test` for the synthetic release checks. Live rendering helpers may require their own browser, video engine or operator-provided model.

The native app supports a scoped business service (`npm run business`) with an operator-owned data root and signing key. Praxis forwards authenticated requests for a managed deck; grant and storage configuration are separate from this source. See [requirements](docs/Slides-Platform_PRD.md) and [roadmap](docs/ROADMAP.md).

## Optional video runtimes

Video engines are provisioned separately in each running environment. Before accepting rendering work, Lattice checks the existing backend diagnostics. If Remotion or HyperFrames is absent, requests report `VIDEO_BACKEND_UNAVAILABLE` and do not enqueue rendering. No package is installed automatically. Native authoring, PNG/PDF/HTML/PPTX export and audio retain their own runtime dependencies. Existing video histories and artifacts remain readable; queued video work with an unavailable backend stays interrupted until an operator provisions that backend and an authorized user retries it.

## Praxis integration

The app-owned [provider contract](docs/PRAXIS-PROVIDER.md) supplies authorized source-backed cards and data-source metadata without exposing a new HTTP endpoint. Run `npm run test:provider` for the isolated provider checks.

## Praxis registration

App release: `0.2.1`. The app owns [`praxis-app.json`](praxis-app.json), its English and Simplified Chinese presentation, the icon at `public/praxis-icon.svg`, the declared PRD locations and any legacy icon aliases. `schemaVersion: 1` identifies the registration format; it is separate from this app release and from data, protocol and document revisions. Package and lockfile release metadata, where present, agree with the declaration.

[`apps.example.json`](apps.example.json) registers a local alias by referencing `./praxis-app.json` and `http://127.0.0.1:4666/`. Start the standalone service described above before using the example; registration does not start a backend or grant account, administrator or business-data access. Installation origins, data locations and access policy remain separately configured.

## App-owned container build

`Dockerfile.praxis` builds this application from its own repository, without a Praxis checkout or an external build context:

```sh
docker build -f Dockerfile.praxis -t praxis-lattice-slides:local .
```

Use the application configuration and persistent data locations documented above when running the image. The Praxis installation consumes the same app-owned build and deployment declaration.

## 应用自有容器构建

`Dockerfile.praxis` 可直接从本应用仓库构建，无需 Praxis 源码或额外构建上下文：

```sh
docker build -f Dockerfile.praxis -t praxis-lattice-slides:local .
```

运行镜像时沿用上文的应用配置与持久数据位置。Praxis 安装流程使用同一份应用自有构建文件与部署声明。

## SQLite storage and conversion

Structured runtime records use the app database. The explicit operator command is `npm run storage:migrate -- --spec /absolute/private/sources.json --database /absolute/private/app.db --receipt /absolute/private/receipt.json --writers-stopped`. The private spec is an array of `{file, spaceId, documentId}` source references. Stop every writer, keep original files, and verify the receipt before activating the new binding. Existing JSON inputs remain explicit compatibility/import sources; a configured database never silently falls back to them. `--export --database /absolute/private/app.db --space SPACE --document state --output /absolute/private/new-export.json` exports an exact logical namespace for recovery. Files/assets keep their existing ownership.
