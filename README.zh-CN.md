# Lattice / 演示文稿

[English](README.md)

Lattice 为演示文稿提供原生工作台、渲染与演示引擎。首次启动时文稿目录为空。真实演示、录音和导出文件放在各自的私有工作空间。

使用 Node 22.16 或更新版本运行 `npm ci --ignore-scripts` 和 `npm run dev`，打开 4666 端口。执行 `npm run build` 生成本地与受管前端文件，再以 `npm start` 提供服务；`npm test` 运行合成验证。受管模式需独立配置存储与签名密钥。

## 可选视频运行时

视频引擎由各运行环境单独配置。接受渲染任务前，Lattice 使用已有的后端诊断检查运行条件。Remotion 或 HyperFrames 未安装时，请求返回 `VIDEO_BACKEND_UNAVAILABLE`，不进入渲染队列，也不会自动安装软件包。原生文稿制作、PNG/PDF/HTML/PPTX 导出及音频沿用各自的运行依赖。保留既有视频历史与产物；后端不可用时，排队视频作业保持中止，待运维配置后端并由获授权用户重试。
