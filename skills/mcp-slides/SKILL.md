---
name: mcp-slides
description: Author, update, inspect and export authorized presentations and media using native Lattice layouts and tools. 通过原生 Lattice MCP 制作、修改、检查和导出演示文稿及媒体；保留已选模板和原生布局，不修改库或代码。
---

# Author with Lattice MCP

English · [简体中文](#lattice-mcp-制作)

Read native capabilities, the chosen template and slot guidance before filling template components. Preserve the selected template, theme, fonts, layout and library code. Do not replace them with hand-positioned text boxes, HTML/JS/CSS or a reduced renderer.

| Tool | When and how to use it |
| --- | --- |
| `slides_get_capabilities` | Discover actual templates, components, exports and limitations before authoring. |
| `slides_get_media_catalog` | Check the real voices, music, media engines and dependencies. Report missing configuration. |
| `slides_get_template` | Check the requested template ID, variables, version and slots. Keep the native template identity. |
| `slides_get_slot_guidance` | Read the exact field definitions, format and depth budgets before editing a slot. |
| `slides_list_decks` | Discover authorized decks and revisions. Do not enumerate unknown spaces or speaker-note content. |
| `slides_read_deck` | Read the identified deck and required slides. Speaker notes require independent notes permission. |
| `slides_create_deck` | Initialize an explicitly authorized ID with the specified native template. |
| `slides_apply_edits` | Submit typed slot, slide-structure, note and timeline edits atomically. Use exclusive `reset_template` only for an explicit rebuild, preserving history on the same resource. |
| `slides_list_assets` | List assets belonging to the deck and their references. An asset ID does not authorize use in other decks. |
| `slides_create_upload` | Request a temporary upload using the actual MIME type, size and SHA-256. Do not submit host paths. |
| `slides_write_upload_chunk` | Upload bounded base64 chunks in order with the correct offset. Retry the same chunk with its original key. |
| `slides_finish_upload` | Confirm size, hash and format. Attach the resulting asset ID to the deck explicitly if required. |
| `slides_import_asset` | Start a durable job using an allowed source and read its asset ID on completion. Do not invent permissions or asset rights. |
| `slides_remove_asset` | Remove only an unreferenced asset of this deck. Leave in-use resources and host files alone. |
| `slides_preview` | Generate the real preview for a fixed revision. Inspect the output after the job finishes. |
| `slides_check` | Run structural or actual-render checks for the requested revision and retain the issues reported. |
| `slides_validate` | Run native validation and resolve field, layout and component errors. Keep validation enabled. |
| `slides_lint` | Use actual native quality results to fix specific issues. |
| `slides_budget` | Check native capacity, depth and content budgets before trimming. |
| `slides_export` | Export the verified revision. For editable PowerPoint require `requireEditable:true` and report any failure to produce editable output. |
| `slides_prepare_audio` | Generate audio using supported voices and parameters. Read the job status, then attach the resulting audio to its slide as required. |
| `slides_render_video` | Check the engine, timeline and tracks; wait for actual captions/video and report missing dependencies. |
| `slides_review` | Run native review/audience capabilities when configured and report actual results. |
| `slides_get_job` | Inspect real job state and outputs. Report delivery only after completion. |
| `slides_cancel_job` | Cancel the exact specified active job without touching unrelated records. |
| `slides_retry_job` | Retry only the original failed, retryable job under its existing revision, inputs and permissions. |
| `slides_get_artifact` | Retrieve the actual preview or export. For visual review, inspect the returned image; metadata alone leaves visual appearance unverified. |
| `slides_list_revisions` | Read the same resource’s revision history rather than inferring versions from filenames. |
| `slides_restore_revision` | On an explicit restore request, create a new current revision and preserve prior history. |
| `slides_set_content_lock` | Set locks only within the authorized scope. Respect them across tools. |
| `slides_archive_deck` | Archive the exact authorized deck and describe the result as archival. |
| `slides_get_links` | Obtain protected reading/presentation URLs. Presenter notes still require separate permission. Keep access tokens out of URLs. |

Submit edits against the current revision with a fixed key per intent. Reread on conflict. Retain the relationship between slide content and notes, and all content the user requested. Describe native capability limits accurately.

After saving, verify the revision by reading back, run native checks, inspect the actual preview and deliver the corresponding files. Distinguish successful tool execution, visual inspection, a verified PDF page count and verified editable PowerPoint. Do not invent download links or claim inspection of unseen output. Stop on authentication/authorization failure. Check an unknown outcome with the same key; do not circumvent the service through client cache, startup settings or raw deck files.

# Lattice MCP 制作

先读取原生能力、指定模板和槽位指引，使用其组件填数据。模板、主题、字体、布局及库代码是实现，不是可自由改写的业务内容。不得用自制定位文字框、HTML／JS／CSS或缩减版渲染器替代原生模板。

| 工具 | 选择与操作 |
|---|---|
| `slides_get_capabilities` | 制作前发现实际模板、组件、导出能力及限制，不能凭旧记忆发明接口。 |
| `slides_get_media_catalog` | 查询实际声音、音乐及媒体引擎和依赖，未配置能力如实报告。 |
| `slides_get_template` | 核对用户选定模板 ID、变量、版本和槽位；保留其原生身份。 |
| `slides_get_slot_guidance` | 编辑前读取精确字段、格式和深度预算，按槽位填内容。 |
| `slides_list_decks` | 发现当前获授权文稿与修订号，不列出未知空间或讲稿内容。 |
| `slides_read_deck` | 读取目标文稿及所需页；讲稿仅在有独立 notes 权限时读取。 |
| `slides_create_deck` | 在明确授权 ID 上用指定原生模板初始化，不建立新的渲染系统。 |
| `slides_apply_edits` | 按类型原子提交槽位、页结构、讲稿、时间线等编辑；显式重做才用独占`reset_template`，保留同资源历史。 |
| `slides_list_assets` | 查询仅属于该文稿的素材及引用，素材 ID 不等于跨稿访问权。 |
| `slides_create_upload` | 按实际 MIME、大小及 SHA-256 申请临时上传，不能传入宿主路径。 |
| `slides_write_upload_chunk` | 按准确 offset 顺序上传有界 base64 块，同块重试使用同幂等键。 |
| `slides_finish_upload` | 完成大小、哈希和格式验证；得到素材 ID 后仍需显式挂入文稿。 |
| `slides_import_asset` | 通过允许的素材来源创建持久作业，完成后读取素材 ID，不伪造授权或权利归属。 |
| `slides_remove_asset` | 仅删除目标文稿未引用的素材，不能删仍在使用的资源或宿主文件。 |
| `slides_preview` | 生成当前固定版本的实际预览，作业创建不是看图完成。 |
| `slides_check` | 对指定版本执行结构／实际渲染检查，保留真实问题报告。 |
| `slides_validate` | 调用原生校验并处理字段、布局及组件错误，不能关闭门禁冒充通过。 |
| `slides_lint` | 读取实际原生质量结果，按具体问题修复而非重写模板。 |
| `slides_budget` | 核对原生容量、深度及内容预算，再进行必要精简。 |
| `slides_export` | 导出已核对版本；可编辑PPTX要求`requireEditable:true`，不得悄悄降级为截图。 |
| `slides_prepare_audio` | 用原生声音及参数生成音频；读取实际作业状态，音频就绪不代表已挂入页。 |
| `slides_render_video` | 核对引擎、时间线和音轨，等待实际生成字幕／视频，缺失依赖准确报告。 |
| `slides_review` | 使用原生审阅／观众能力生成结果，未配置服务不能伪装成功。 |
| `slides_get_job` | 查询真实作业状态及输出；排队或运行中不能报告交付完成。 |
| `slides_cancel_job` | 取消明确指定的当前作业，不清理无关业务记录。 |
| `slides_retry_job` | 只重试失败且可重试的原作业，保留其版本、输入和权限约束。 |
| `slides_get_artifact` | 获取真实预览或导出产物；需要看图时检查实际 image 内容，只有元数据就报告视觉未验。 |
| `slides_list_revisions` | 核对同一资源的保存历史，不从文件名推断版本。 |
| `slides_restore_revision` | 用户要求恢复时创建保留历史的新当前版本，不覆盖旧历史。 |
| `slides_set_content_lock` | 按明确授权设置内容锁，锁住的内容不得通过另一工具绕过。 |
| `slides_archive_deck` | 归档确切授权文稿，不把归档冒充不可恢复的永久删除。 |
| `slides_get_links` | 获取受保护的阅读／展示地址；presenter讲稿仍需独立权限，不生成公开访问或在 URL 暴露 token。 |

编辑带当前修订号和固定幂等键，冲突回读后再判断。保持正文和讲稿关系及用户要求的全部内容；库能力不足准确说明，不阉割交付。

完成后回读版本，检查真实预览和原生门禁，再交付对应版本的实际文件。工具返回成功、视觉已验、PDF页数正确、可编辑PPTX分别陈述；看不到图不能说视觉通过，文件未生成不能给虚构下载链接。权限／认证失败停止，未知结果同键核查，不能修改客户端缓存、启动或原始文稿文件绕过。
