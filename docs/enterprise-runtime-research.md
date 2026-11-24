# Enterprise Runtime POC：市场、源码复用与许可证调研

> 调研日期：2026-11-23。本文是本 POC 的工程与许可证追溯记录，不构成法律意见。结论只覆盖本仓 `packages/experimental/enterprise-runtime` 的直接代码与直接运行时依赖；发布前仍应按发行流程生成完整第三方 notices/SBOM。

## 目标、范围与方法

本调研回答两个问题：是否需要复用现成的 ZIP/插件方案，以及当前最小 POC 复用了什么代码、在什么许可证条件下复用。

检索/比较范围限定为：

1. Node.js ZIP 归档读取库和平台原生解压能力；
2. Harness 已有 Cordis 生命周期、工具注册、schema 与 JSON value 基础设施；
3. 可选数据源/Langfuse 集成的边界与安全风险。

可复核的外部来源（均于上述日期查阅链接和版本标识；本文不把 registry 元数据中的 `license` 字段作为许可证结论的唯一依据）：

- [yauzl 3.4.0 registry tarball](https://registry.npmjs.org/yauzl/-/yauzl-3.4.0.tgz) 与 [上游 LICENSE](https://github.com/thejoshwolfe/yauzl/blob/master/LICENSE)
- [pend 1.2.0 registry tarball](https://registry.npmjs.org/pend/-/pend-1.2.0.tgz) 与 [上游 LICENSE](https://github.com/andrewrk/node-pend/blob/master/LICENSE)
- [Node.js `zlib` API](https://nodejs.org/api/zlib.html)
- [JSZip repository](https://github.com/Stuk/jszip) 与 [LICENSE](https://github.com/Stuk/jszip/blob/main/LICENSE.markdown)
- [node-stream-zip repository](https://github.com/antelle/node-stream-zip) 与 [LICENSE](https://github.com/antelle/node-stream-zip/blob/master/LICENSE)
- [Cordis repository](https://github.com/shigma/cordis)；本仓实际 vendored 副本的 [LICENSE](../vendor/cordis/LICENSE)
- 本仓根 [LICENSE](../LICENSE) 与 [third-party notices generator](../scripts/gen-third-party-notices.ts)

相对链接用于审阅本候选实际使用的文件；外部链接用于复核上游来源。未在本次 POC 中下载、复制或调用的候选只作为比较对象，不因此成为产品依赖。

## 方案比较与复用决定

| 候选/复用点 | 调研结论与决定 | 与 POC 边界的关系 |
|---|---|---|
| `yauzl@3.4.0` | **采用**。以 `fromBuffer` 读取上传的内存 ZIP；代码逐项检查路径、数量和解压后尺寸，再自行解析 manifest 与声明式 entry。它不执行 ZIP 内的 JavaScript。 | 是唯一新增的外部归档读取依赖；用于可验证的二级 ZIP 加载，不构成通用插件市场或任意代码加载器。 |
| Node `zlib` | **不采用为实现依赖**。平台 API 能处理压缩流，但不提供 ZIP central-directory/entry 安全策略；自行拼装 ZIP parser 会扩大安全和维护范围。 | 不新增实现或许可证义务。 |
| JSZip | **不采用**。浏览器/构建场景适配面大于本 Host-only 读取需求；本 POC 不生成 ZIP，也不需要浏览器解压。 | 不复制其代码，不引入其包。 |
| node-stream-zip | **不采用**。其文件/流式访问模型不比 `yauzl` 更适合本 POC 的小尺寸、内存 ZIP staging；额外 API 面不能改善现有安全边界。 | 不复制其代码，不引入其包。 |
| Harness vendored Cordis、Schemastery、`dsh-tools`、`dsh-util-values` | **复用既有仓内能力**。Runtime 用 Cordis `Service` 生命周期、Schemastery 配置校验、工具注册和 JSON-safe 类型；未复制这些组件源码。 | 复用受管一级 Host API，二级 ZIP 从不拿到 Context、provider 或工具注册能力。 |
| Plugin Manager / client slot | **只复用详情 slot**。当前静态说明区不传递 ZIP payload，不能安装、扫描或执行二级包。 | 避免把受信 Host 安装入口扩大到 Web client。 |
| 外部“企业插件/市场”业务源码 | **未采用/未复制**。本 POC 的 manifest、staging、权限和模板解析均为本仓新增代码，而非移植外部业务实现。 | 不声称与任何外部市场、Langfuse UI 或连接器兼容。 |

`yauzl` 的直接依赖 `pend@1.2.0` 会随安装解析，但 Runtime 源码不直接 import 或调用它；仍在下节列出为随 `yauzl` 分发的运行时第三方组件。

## 许可证核验与履行结论

许可证类型以下列**实际许可证文本**为准，而不是仅引用 `package.json` 的 SPDX 字段。版本由当前 `package.json`/lockfile 约束，来源链接指向可审阅的上游 artifact 或本仓许可证文本。

| 实际复用的依赖/代码 | 版本/用途 | 许可证与核验来源 | 适用义务 | 本 POC 履行结论 |
|---|---|---|---|---|
| `yauzl` | `3.4.0`；ZIP entry 读取 | MIT；[3.4.0 tarball](https://registry.npmjs.org/yauzl/-/yauzl-3.4.0.tgz) 内 `LICENSE`，可与[上游文本](https://github.com/thejoshwolfe/yauzl/blob/master/LICENSE)比对 | 再分发该软件或其实质部分时保留版权与许可文本；无 copyleft 源码公开要求。 | 当前源码未复制 `yauzl` 源文件；发行包若携带此依赖，发行前的 third-party notices/SBOM 必须保留其 MIT notice。 |
| `pend`（`yauzl` 传递依赖） | `1.2.0`；由 `yauzl` 解析 | MIT/Expat；[1.2.0 tarball](https://registry.npmjs.org/pend/-/pend-1.2.0.tgz) 内 `LICENSE`，可与[上游文本](https://github.com/andrewrk/node-pend/blob/master/LICENSE)比对 | 同上，随发行依赖保留 notice。 | 不直接调用或复制；作为随包解析依赖纳入发布 notices/SBOM 检查。 |
| `@deepseek-ai/cordis`（vendored） | workspace peer；`Context`/`Service` | MIT；本候选的 [`vendor/cordis/LICENSE`](../vendor/cordis/LICENSE) | 再分发实际代码或 substantial portions 时保留 notice。 | 仅按 workspace import；仓内已保留许可证文本。最终发行仍纳入 notices generator。 |
| `@deepseek-ai/schemastery`（vendored） | workspace dependency；配置 schema | MIT；本候选的 [`vendor/schemastery/LICENSE`](../vendor/schemastery/LICENSE) | 同上。 | 仅按 workspace import；仓内已保留许可证文本。 |
| `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-util-values` | workspace peer/dependency；真实工具注册和 JSON-safe 类型 | MIT；本仓根 [`LICENSE`](../LICENSE) 覆盖本仓代码，package 的 SPDX 字段仅作辅助定位 | 再分发本仓代码时保留根 MIT notice。 | 未复制到 Runtime；同仓发布流程应保留根 notice 并生成第三方 notices。 |
| 本 POC 新增 Runtime / manifest / template 代码 | 本 PR | MIT；本仓根 [`LICENSE`](../LICENSE) | 保留本仓 notice。 | 代码置于同一 MIT 仓库，未附加外部版权文本。 |

未知项：本调研未对上述依赖的**全部传递依赖树**逐包进行法律尽调，也未确认未来发行制品会如何打包每个依赖；这不能由 SPDX 字段推断。该未知不阻止本 POC 的源代码评审，但在发布/分发前必须以锁文件、制品和 notices/SBOM 的实际输出复核。没有发现本 POC 复制的外部业务源码；若后续复制样例、UI 或连接器代码，须在合入前新增来源、版权和许可证记录。

## 信任模型与未纳入范围

### ZIP 信任与隔离

二级 ZIP 是**不受信数据**，不是可执行插件：当前实现只接受 JSON manifest 与声明式 list/detail/chart/report entry。Host 侧执行的现有控制包括 ZIP/文件/解压尺寸上限、拒绝绝对路径和 `..` traversal、manifest/runtime API/permissions/template 校验、staging 后原子发布，以及失败时不发布 inventory。二级内容不获得 Cordis `Context`、工具注册、文件系统对象或 data-source provider。

签名验证、恶意文件扫描、来源/发布者身份、SBOM 附带、沙箱进程隔离和租户级审批**没有在本 POC 实现**。因此它不适合被表述为可接收任意第三方生产 ZIP；后续若扩大到外部 ZIP 分发，应先定义签名信任根、扫描/隔离策略、审计和撤销机制。

### 数据源与 Langfuse

`DataSourceApi@v1` 只是在 Host 中可选发现的只读 provider 接缝。Runtime 仅透传 JSON-safe query，并在 provider 缺失时返回 `data-source-unavailable`。本 POC 没有数据源 connector、鉴权、凭据持久化、网络访问或行级授权实现。

Langfuse 仅有问题形状的 report query 示例；没有 Langfuse SDK、HTTP 调用、endpoint、token、数据导入或 UI。是否接入 Langfuse、何种权限模型和第三方条款审查均为后续独立范围。

## 验收边界与后续动作

本调研支撑当前“声明式、受信 Host 安装”的 POC 决策，不替代安全评估或发布合规审计。已验证的 Host facade 生命周期与静态 client slot 测试在各自测试记录中维护；**真实浏览器 Plugin Manager 操作/截图没有验证**，因为当前没有 Browser MCP 或已部署候选。该缺口不应被本文或任何 jsdom 结果表述为已通过。
