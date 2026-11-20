# Lattice / 演示文稿

[English](README.md)

Lattice 为演示文稿提供原生工作台、渲染与演示引擎。首次启动时文稿目录为空。真实演示、录音和导出文件放在各自的私有工作空间。

使用 Node 22.16 或更新版本运行 `npm ci --ignore-scripts` 和 `npm run dev`，打开 4666 端口。执行 `npm run build` 生成本地与受管前端文件，再以 `npm start` 提供服务；`npm test` 运行合成验证。受管模式需独立配置存储与签名密钥。

## 可选视频运行时

视频引擎由各运行环境单独配置。接受渲染任务前，Lattice 使用已有的后端诊断检查运行条件。Remotion 或 HyperFrames 未安装时，请求返回 `VIDEO_BACKEND_UNAVAILABLE`，不进入渲染队列，也不会自动安装软件包。原生文稿制作、PNG/PDF/HTML/PPTX 导出及音频沿用各自的运行依赖。保留既有视频历史与产物；后端不可用时，排队视频作业保持中止，待运维配置后端并由获授权用户重试。

## Praxis 集成

应用维护的[供数合同](docs/PRAXIS-PROVIDER.md)提供按授权过滤、有来源依据的卡片与数据源描述，不增加 HTTP 元数据入口。使用 `npm run test:provider` 验证隔离供数测试。

## Praxis 登记

应用发行版本：`0.2.1`。本应用维护 [`praxis-app.json`](praxis-app.json)、英中展示文案、`public/praxis-icon.svg` 图标、PRD 路径及需要保留的旧图标别名。`schemaVersion: 1` 表示登记格式，与应用发行版本、数据、协议和文档修订分别管理；已有 package 和 lockfile 的发行版本须与声明一致。

[`apps.example.json`](apps.example.json) 引用 `./praxis-app.json`，使用 `http://127.0.0.1:4666/` 登记本地别名。先按上文启动独立服务；登记不启动后端，也不授予账号、管理员或业务数据权限。安装地址、数据位置与授权策略仍独立配置。

## SQLite 存储与转换

结构化运行记录使用应用数据库。运维命令为 `npm run storage:migrate -- --spec /absolute/private/sources.json --database /absolute/private/app.db --receipt /absolute/private/receipt.json --writers-stopped`，私有 spec 数组每项为 `{file, spaceId, documentId}`。先停所有写者、保留原文件，比对回执后才激活新绑定。JSON 保留为显式兼容/导入来源，配置数据库时不静默回退。`--export --database /absolute/private/app.db --space SPACE --document state --output /absolute/private/new-export.json` 可导出逻辑命名空间以恢复。原件/素材保持归属。
