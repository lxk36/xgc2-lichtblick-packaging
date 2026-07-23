# Lichtblick 维护边界

本文档是 XGC2 集成 Lichtblick 的强制维护规约。目标是让 Lichtblick 保持可替换的
官方上游制品，避免 XGC2 再次形成长期源码分叉。

## 唯一维护入口

- `lichtblick-packaging` 是 XGC2 唯一维护的 Lichtblick 仓库边界。
- 构建只能从 `lichtblick.lock` 指定的官方
  `https://github.com/lichtblick-suite/lichtblick.git` tag 和 commit SHA 获取源码。
- `external/dev/xgc2-lichtblick` 只用于阅读、调试和核对官方接口；它必须指向官方
  仓库并保持无本地修改。它不是构建输入，也不是产品源码。
- 禁止恢复 `products/webui/xgc2-lichtblick`，禁止把 remote 改成 XGC2 fork。

## Packaging 可以负责什么

- 固定并校验上游版本、Node/Yarn/FPM 等构建输入；
- 构建 Web/Electron Debian 包及执行安装、启动和卸载验证；
- 提供通用静态文件服务器、WebSocket 反向代理、来源/CSP 限制、健康检查和版本信息；
- 维护包元数据、CI、发布和升级工作流。

Packaging 不得携带 XGC2 默认布局、机器人、网格、坐标轴、相机视角或 TF 跟踪策略，
也不得通过源码补丁、patch queue、构建时改写、运行时 monkey patch 或访问
Lichtblick 内部状态来实现这些功能。

## XGC2 domain 负责什么

- 工作流节点读取面板参数并生成每次 Run 使用的 Lichtblick JSON 布局；
- 业务侧组合基础面板、网格、坐标轴、机器人和可扩展场景；
- 通过 Lichtblick 官方公开的 URL、布局导入或扩展接口把配置交给 Web 节点；
- 在 XGC2 Lite/domain 中持久化业务配置和用户选择。

固定相机参数与 TF 跟踪策略属于互斥的业务状态。若官方公开接口允许导出当前视图，
XGC2 可以按节流策略持久化，并且只在下一次启动时恢复一次；恢复完成后不得持续抢占
用户的交互控制权。

## 官方接口不足时

需要的能力若无法通过当前官方公开接口实现，应先核对官方文档和版本行为，然后选择：

1. 向 Lichtblick 官方提交通用能力并等待发布；
2. 在 XGC2 中将能力标记为暂不支持。

不得以修改 `external/dev` 源码、重新建立 XGC2 源码 fork 或向打包服务器注入内部状态
访问代码作为替代方案。尤其是视角/TF 策略的自动采集，在没有稳定官方导出接口前应视为
未完成能力，而不是依赖私有实现。

## 升级检查

升级 Lichtblick 时必须：

1. 只更新 `lichtblick.lock` 中的官方 tag 和精确 SHA；
2. 确认 `external/dev/xgc2-lichtblick`（如用于核对）与该官方版本一致且无本地 diff；
3. 核对 XGC2 使用的布局 JSON 和公开接口契约；
4. 运行 packaging 合规检查、Web 测试和全部相关包构建；
5. 拒绝任何包含 Lichtblick 源码补丁、内部状态注入或 XGC2 默认布局的变更。
