# DeepSeek Harness 统一数据源一级插件：调研结论与 MVP 方案

> 范围：这是一个可独立安装的 Harness 一级插件，不依赖自生长 Runtime。Runtime 若存在，只能通过本文定义的公开契约选用它。本文件不延续本仓库的 FastAPI MVP 实现。

## 结论

**有条件可行，但没有可直接安装的现成 DSH 数据源插件。** DeepSeek Harness（DSH）已经原生提供了可安装 bundle、Plugins 侧栏与配置页、工具注册、凭据模板、MCP 桥接和动态重载；最短方案是新建很薄的 `@ruyi/dsh-data-sources` bundle，直接复用 DSH 的插件管理与 MCP client/manager，而不是从零写聊天宿主、插件加载器或连接器协议。

MVP 的连接器通过受约束 MCP server 运行：本地目录和 PostgreSQL 有可直接采用的候选；S3 采用后可立即进入 POC；MySQL 只能 fork/收紧；SFTP 无质量达标候选，需要小型自研 adapter（建立在成熟 SSH/SFTP library 上）。所有连接默认只读，凭据仅以 DSH credential 引用保存。

## 调研基线与 Harness 原生能力

调查基线是官方仓库 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)，commit [`4b399c39a6d1479cd84ca591b4d7c88e24d38a96`](https://github.com/deepseek-ai/deepseek-harness/commit/4b399c39a6d1479cd84ca591b4d7c88e24d38a96)，包版本 `0.2.3-alpha.2`，MIT。该仓库近期仍有提交；其根 `package.json` 要求 Node `^24.22.3 || >=26.13.1`。

| 需求 | 结论 | 可核查证据 / 限制 |
|---|---|---|
| 独立安装、启停、卸载 bundle | 原生支持 | [`publish.md`](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/docs/user/develop/basic/publish.md) 定义 `dsh.bundle`、profile 层次及 `dsh plugin add/remove`；`plugin-manager` 记录安装前检查、兼容性和 HMR/重启语义。安装的 Host 代码进程内执行，不能把包安装当作沙箱。 |
| Plugins 侧栏、配置 UI | 原生支持 | [`ui-plugin-manager`](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/client/ui-plugin-manager/README.md#configuration-pages) 提供 `plugins.bundle.config`、`plugins.row.config` 与 `settings.section`；[`ui-sidebar`](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/client/ui-sidebar/README.md#global-panel-entries) 也允许以 `sidebar.panellist` + `main` 添加独立面板。MVP 首选 Plugins 配置页，避免先做一个不必要的新主面板。 |
| 对话工具注册和生命周期卸载 | 原生支持 | [`adding-a-tool.md`](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/docs/cookbook/adding-a-tool.md) 的 `ctx.tools.register()`；注册是 effect，插件卸载时自动注销。工具输入 schema 由 DSH 校验，但业务越权校验仍由插件负责。 |
| 外部数据服务接入 | 原生支持（MCP 适配） | [`dsh-mcp-client`](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/mcp/mcp-client/README.md) 将 stdio/Streamable HTTP MCP 工具注册为 `mcp__<server>__<tool>`；[`dsh-mcp-manager`](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/mcp/mcp-manager/README.md) 支持运行时配置、probe、启停和 plugin-lifetime registration。 |
| 凭据隔离 | 原生支持，但需按约束配置 | `mcp-manager`/`mcp-client` 支持 `${credential:REF}`，运行时展开并在诊断中脱敏；不能把 DSN、access key 或私钥写进配置、tool 参数、日志或会话。 |
| 插件市场 | 只有通用索引机制，**没有官方默认市场/数据连接器目录** | [`plugin-market.md`](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/docs/user/guide/plugin-market.md) 明确 DSH 不带 index source，第三方 index 声明不构成 DSH 背书；本次源码关键词检索未发现 PostgreSQL、MySQL、SFTP、S3/MinIO/OSS 或 datasource 的第一方 connector。 |
| 插件公开 API / 浏览器 Remote | 原生支持，需自定义实现 | [`adding-a-remote-api.md`](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/docs/cookbook/adding-a-remote-api.md) 定义 `TypertRemoteService`/`@Remote`、失败码和 client codec；它不是现成数据源 API。 |

## 候选复用比较

| 候选 | 覆盖与证据 | 许可证 / 维护信号 | 判定 |
|---|---|---|---|
| DSH `dsh-mcp-manager` + `dsh-mcp-client` | 支持受控 stdio/HTTP MCP、连接状态、probe、credential template、工具注册；上表官方源码定位 | DSH MIT；与当前 `0.2.3-alpha.2` 同仓同版本 | **直接采用**，作为所有 connector 的宿主适配层。 |
| [`@modelcontextprotocol/server-filesystem`](https://github.com/modelcontextprotocol/servers/tree/c799c8552b0f27b7a33a7b9233773da144dddcf5/src/filesystem) | 支持 allowed roots、`--read-only`、路径/符号链接防逃逸；MCP 官方 reference repo 当前有活跃提交 | MCP repo 正在由 MIT 过渡到 Apache-2.0，具体源码贡献须按仓库 LICENSE 处理；Node `>=24` | **直接采用**于本地目录：固定绝对 allow-list + `--read-only`；不得依赖已废弃 Roots 动态授权。 |
| [`txn2/mcp-s3`](https://github.com/txn2/mcp-s3) | AWS S3 与 S3-compatible；README 声明只读默认、prefix ACL、对象大小上限、审计开关；支持自定义 endpoint/path style | Apache-2.0；有 Go package、CI/scorecard/coverage 链接，但星标量低（调查时 11） | **POC 直接采用，量产前安全评审**。设 `MCP_S3_EXT_READONLY=true`、大小上限和 prefix；运行权限仍以云 IAM policy 为最终边界。 |
| [`mcp-postgres-server`](https://github.com/antonorlov/mcp-postgres-server) | `PG_ALLOW_WRITE=false` 默认；`BEGIN READ ONLY`、单语句、参数绑定、结果字节/statement timeout、TLS 和可选 SSH host-key verification | MIT；CI badge，依赖面小；调查时 25 stars | **直接采用 POC，生产前封装**。必须使用独立只读 DB role；客户端限制不替代服务端权限。 |
| [`@f4ww4z/mcp-mysql-server`](https://github.com/f4ww4z/mcp-mysql-server) | 有 query/list/describe，但也暴露 `execute`，README 的“验证 query”不足以证明引擎级只读；运行时连接还会使密码进入 tool 参数 | MIT；调查时 171 stars / 37 forks，但最近代码推送为 2025-11 | **仅可 fork 改造或借鉴**：删除 `execute`/runtime-connect，使用只读 MySQL account、单语句/结果/超时限制后才可进入 MVP。 |
| GitHub 可发现 SFTP MCP 项目 | 本次检索仅找到无许可证、无活跃度或零 stars 的 SFTP/SSH MCP 项目，不能证明安全维护质量 | 无可接受成熟候选 | **不直接复用**。用成熟 SSH/SFTP transport library 写小型只读 MCP adapter；这不是 Runtime 工作。 |

结论遵循优先级：DSH/MCP bridge 和本地目录/PostgreSQL 直接采用，S3 先 POC 后审计，MySQL fork 收紧，SFTP 小型 adapter。没有证据支持宣称“阿里 OSS 完全等同 AWS S3”：仅把它当作 S3 API compatibility endpoint，在验收环境逐项验证签名版本、endpoint、region、path/virtual-host style、分页和权限错误；厂商特性不纳入 MVP 承诺。

## MVP 范围与安全边界

### 五类连接器

| 类型 | MVP 接入方式 | 必须的只读约束 | 连接测试成功条件 |
|---|---|---|---|
| AWS S3 / MinIO / S3-compatible endpoint | `txn2/mcp-s3` stdio；每 source 一个命名实例 | 最小 IAM（ListBucket + GetObject，仅允许 prefix）、只读 extension、对象/结果大小与请求超时；不注册上传/删除/presign PUT | 列允许 bucket/prefix，读取一个小型非敏感对象并返回对象 key、etag/size，不能返回 secret。 |
| 阿里云 OSS compatibility | 与 S3 同一 adapter，但连接表单显式 `endpoint`、region、path-style/签名选项 | 同上；没有“全兼容”暗示 | 上述最小读路径在 OSS 专用 fixture 实测；失败归为供应商兼容性而非伪装 AWS 成功。 |
| 本地目录 | official filesystem MCP | 启动参数给绝对 allow-list + `--read-only`，同时使用 OS 最小权限；禁止用户/模型指定新的根 | list/read 仅能到已登记根；尝试根外和写操作必须失败。 |
| SFTP | data-source bundle 管理的只读 MCP adapter | host allow-list、known_hosts 指纹校验、仅 key/credential ref、根路径约束、禁止 exec/shell、大小/分页/timeout | SSH host key 校验后列目录并读一个 fixture；未知/变更 host key 必须拒绝。 |
| MySQL / PostgreSQL | MCP adapter；Postgres 先用候选，MySQL 为收紧 fork | 独立 DB readonly principal、TLS 验证、单语句 SELECT/CTE/EXPLAIN/SHOW allow-list、参数绑定、row/byte/statement timeout；禁止 DDL/DML/copy-out | 读取 schema 和 fixture SELECT；INSERT/UPDATE/DELETE/多语句一律工具层拒绝，DB principal 再次拒绝。 |

统一 source 配置包含稳定 `sourceId`、类型、显示名、非秘密 endpoint/allowed root/数据库名、credential reference、policy、启用状态和版本；**没有**密码、token、私钥、原始 DSN 或可以覆写 policy 的聊天参数。连接测试只返回状态、延迟、server identity 和已脱敏诊断。

## 组件和公开契约

```text
Harness profile
  ├─ @ruyi/dsh-data-sources（独立一级 bundle）
  │    ├─ SourceRegistry：配置、sourceId、策略、审计摘要
  │    ├─ ConnectorSupervisor：委托 DSH McpClientHost/McpManager
  │    ├─ PolicyGuard：限制 source、路径、SQL 类别、分页与结果预算
  │    ├─ 只读工具：list_sources / inspect_source / query_source / read_object
  │    ├─ 配置页：Plugins → Data Sources
  │    └─ @ruyi/dsh-data-sources/api（稳定版本化接口）
  └─ 可选 @ruyi/dsh-runtime（另一独立一级 bundle）
       └─ 只依赖公开 api；不读取 credential、profile 文件或 adapter 内部对象
```

第一版公开 in-process API（包入口 `@ruyi/dsh-data-sources/api`）采用 `v1`：

```ts
type SourceRef = { id: string; revision: string }
type ReadRequest = {
  apiVersion: 'v1'
  source: SourceRef
  operation: 'catalog' | 'object.read' | 'directory.list' | 'sql.query'
  input: Record<string, unknown> // 已按 source policy 校验，绝不接受凭据
  maxBytes?: number
  maxRows?: number
}
type ReadResult = {
  source: SourceRef
  data: unknown
  truncated: boolean
  evidence: { connector: string; observedAt: string; requestId: string }
}
```

- `DataSourcesV1.executeRead()` 仅接收 `sourceId` 和受约束的 read request；Runtime 看不到 credential、MCP command 或连接参数。
- 插件内注册同名 DSH tools 用 schema 把模型限制在这组操作；`PolicyGuard` 在调用前做最终 source policy 检查，不能只依赖模型提示词。
- 浏览器配置页如需 Host 通信，另加版本化 `dataSources` Remote namespace；它仅服务认证过的配置界面。**MVP 不开放未鉴权 HTTP 数据 API**。
- 破坏性或兼容性变化新开 `v2`；`v1` 至少在一个完整 DSH minor 兼容窗口内保留。Runtime 的依赖范围为该公开 package 的 semver 范围，而非内部路径。

## 最短实施顺序（不包含 Runtime）

1. 建立独立 TypeScript bundle 骨架：`package.json` 的 `dsh.bundle`、`engines.dsh: >=0.2.3-alpha.2 <0.3.0`、Host row、client row、配置 schema 和 plugin-manager 安装测试。
2. 实现 SourceRegistry、credential-ref 校验、测试连接和审计摘要；先接 filesystem + PostgreSQL，形成工具调用与 Plugins 配置页闭环。
3. 接入 S3/MinIO，并把 OSS 作为明确的 compatibility test matrix；实现 object byte/前缀策略。
4. 加入收紧后的 MySQL 与自研 SFTP read-only adapter；每类 connector 的拒绝写入测试必须与成功读路径一起交付。
5. 固化 `@ruyi/dsh-data-sources/api` v1 与 integration tests；Runtime 只在此后选择性消费它，两个 bundle 可单独安装和升级。

## 可复现 POC 验收

### 已完成的调查验证

- 已检出并核查官方 DSH 源码 commit `4b399c39a6d1479cd84ca591b4d7c88e24d38a96`；源码与文档确认 bundle、Plugins 配置页、tool lifecycle、MCP manager/client、credential templates 和 Remote API 均存在。
- 对该 commit 做第一方关键词 inventory（PostgreSQL、MySQL、SFTP、S3/MinIO/OSS、datasource）无数据 connector 命中；因此“直接安装现成 DSH 数据源插件”不可成立。
- 已核查 connector 候选的源码/README 与许可证元数据，形成上表复用决策。

### 未完成的运行 POC 与唯一阻塞

本工作机没有 `dsh` 可执行文件，且 Node 是 `v22.22.3`，不满足调查基线要求的 Node 24；同时尚未实现/发布 `@ruyi/dsh-data-sources` bundle。因而**不能诚实报告真实 Harness 对话、真实数据源连接或 UI 截图已通过**。这阻断的是运行验收，不阻断本文的源码级可行性结论。

具备 Node 24、DSH `0.2.3-alpha.2` 和隔离 fixture 后，最小验证按以下顺序执行：

1. `dsh plugin --profile datasource-poc add <pinned-built-tarball>`，在 Plugins 页面启用 bundle，确认只出现 Data Sources 配置页；卸载后工具和页面消失。
2. 添加只读临时目录 source，先列文件再读取 fixture；对根外路径与写工具调用断言拒绝。
3. 添加 PostgreSQL 最小只读角色和 fixture table，完成 schema + `SELECT`；对 DML、DDL、多语句和超预算结果断言拒绝，并从 DB audit/日志读回无写入。
4. 添加 MinIO fixture，限制 bucket/prefix 与对象尺寸；完成 list/get；验证 put/delete 不能注册或被拒绝。
5. 仅在专用 OSS fixture 中重复 S3 matrix；记录每个兼容项而非泛称兼容。
6. 在新聊天 session 用“列出 source / 查询这个 PostgreSQL 数据 / 分析这个 S3 prefix”触发工具，保存 tool evidence；检查 tool result 的 source ID、时间、截断状态和审计 request ID。凭据不出现在截图、日志、Git 或聊天。
7. 编译一个只调用 `@ruyi/dsh-data-sources/api` v1 的 fixture consumer（可替代 Runtime），验证 source list 与受限 read；卸载 data-source bundle 后 consumer 获得明确 `source/unavailable` 错误而非内部对象访问。

## 后续扩展（不进入 MVP）

| 优先级 | 类型 | 适配接口 |
|---|---|---|
| P1 | Elasticsearch、Redis、SQLite、HTTP API、WebDAV | `SourceAdapter.probe/catalog/read`；各自只读 query grammar 与结果预算 |
| P2 | SQL Server、Oracle、FTP、云数仓（BigQuery/Snowflake/ClickHouse/Trino 等） | 同上，另加厂商身份、TLS 与 cost/scan budget policy |
| P3 | 写入、同步、导出、跨源 join | 需要独立授权、审批、审计和数据外传策略；不复用“只读”开关扩权 |

## 证据边界

这是一份调查与方案产物，未修改旧 FastAPI 主线、未安装第三方包、未连接真实 S3/OSS/SFTP/数据库，也未创建 Runtime 依赖。候选 README 的安全声明是选型输入，不等同本插件的安全证明；最终验收以固定候选版本上的实际只读数据读回、拒绝写入断言和可见 UI/tool evidence 为准。
