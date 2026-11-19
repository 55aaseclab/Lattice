# Lattice / 演示文稿

[English](README.md)

Lattice 为演示文稿提供原生工作台、渲染与演示引擎。首次启动时文稿目录为空。真实演示、录音和导出文件放在各自的私有工作空间。

使用 Node 22.16 或更新版本运行 `npm ci --ignore-scripts` 和 `npm run dev`，打开 4666 端口。执行 `npm run build` 生成本地与受管前端文件，再以 `npm start` 提供服务；`npm test` 运行合成验证。受管模式需独立配置存储与签名密钥。
