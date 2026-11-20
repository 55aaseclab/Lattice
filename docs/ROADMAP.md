# Built-in distribution / 内置发布

Pin the public engine and its empty workbench in Praxis. Verify browser rendering and protected deck operations with synthetic documents.

在 Praxis 中固定公开引擎与空文稿工作台，并使用合成文稿核对界面和受保护的文稿操作。

## Optional runtime checks / 可选运行时检查

Use existing backend diagnostics before video queueing and execution. Verify missing-engine behavior and non-video functionality without deleting declared dependencies, implementation code, historical jobs or artifacts.

在视频排队和执行前复用已有后端诊断。验证引擎缺失时的明确状态及非视频功能，保留依赖声明、实现代码、历史作业与产物。

## Praxis provider / 工作台供数

Publish the app-owned card and data-source contract. Verify synthetic authorized records, native links, stable revisions, empty/error separation and metadata resolution. Keep storage keys, business records and video provisioning outside this module.

发布由应用维护的卡片与数据源合同，使用合成授权记录验证原生入口、稳定版本、空态与错误区分及元数据解析。供数模块不接触密钥、真实业务记录或视频引擎安装。

## App-owned Praxis integration

This app owns its reviewed `praxis-integration.mjs`: native entry policy, typed business operations and MCP guidance where supported. Praxis loads that declaration from the installed source and retains authorization, signing, policy leases and audit. Installation does not grant access or start a backend. Existing native interfaces, data ownership and recovery boundaries remain in force.

## 应用自有 Praxis 集成

本应用在所属仓库维护经审核的 `praxis-integration.mjs`，声明原生入口策略，以及已支持的类型明确的业务操作与 MCP 指引。Praxis 从已安装源码加载声明，继续统一执行授权、签名、策略租约与审计。安装声明不会授予访问权限，也不会启动后端；已有原生界面、数据归属与恢复边界继续生效。

## SQLite 切换

先定义保真条件，再实现原生存储及显式转换/导出，验证合成 API/界面/并发和恢复一致，随后先发布所属仓版本，再由平台固定部署；保留旧文件和原始素材。
