# 图像生成与审核

[English](README.md) | 中文

此 bundle 为 DeepSeek Harness 提供 `generate_image_with_review` 工具。它发送 OpenAI-compatible 图像生成请求，再让独立配置的视觉模型按给定验收标准检查结果，并将接受的图片保存为 Harness attachment。

## Desktop 配置

Windows Internal Test Desktop 会在本地 runtime 中交付此 bundle，因此无需源码 checkout 或插件安装命令。在 Settings 中打开 **Plugins**，选择**图像生成与审核**，并在此保存提供方设置。

普通字段为 `imageBaseUrl`、`imageModel`、`imageCredential`、`reviewBaseUrl`、`reviewModel`、`reviewCredential`、`maxIterations`、`timeoutMs`、`defaultSize`、`defaultQuality` 和 `outputFormat`。凭据字段填写 POSIX-compatible 引用名，而不是 secret 值。`maxIterations` 接受 1 到 3，`timeoutMs` 必须不小于 1000，`outputFormat` 接受 `png`、`webp` 或 `jpeg`。

在各自的 password 字段中输入 API key。Desktop 通过 credentials service 写入它，而不是写入 settings file；屏幕只报告指定引用是否已配置且可写。将 password 字段留空会保留当前值。

保存后，在普通对话中请求生成图像并提供验收标准。agent 可以发现并调用 `generate_image_with_review`；最终 attachment 会显示在标准 conversation image gallery 中。此 bundle 不新增独立生图页面，也不修改 agent loop。

## Profile 配置

非 Desktop profile 可以添加本地 bundle，然后在 profile patch 中配置相同的非 secret 字段。下面的 credential reference 仅为名称。

```sh
dsh plugin --profile web add ./image-iterate-plugin
```

```yaml
- id: image-iterate-plugin
  name: dsh-image-iterate-plugin
  config:
    imageBaseUrl: https://api.example.com/v1
    imageModel: gpt-image-2
    imageCredential: IMAGE_API_KEY
    reviewBaseUrl: https://api.example.com/v1
    reviewModel: vision-model
    reviewCredential: VISION_API_KEY
    maxIterations: 2
    timeoutMs: 120000
    defaultSize: 1024x1024
    defaultQuality: medium
    outputFormat: png
```

通过 DSH credentials service 或启动环境配置被引用的凭据。不要将 key 写入 `cordis.patch.yml`、Issue、log 或 screenshot。每次工具调用都会再次解析凭据，因此轮换 key 不需要重启。

## 失败与限制

- 缺少普通配置时，会返回结构化 `MISSING_CONFIG` 失败，并指向 Desktop Settings 或 profile patch。
- 缺少凭据时，会返回结构化 `MISSING_CREDENTIAL` 失败，且不会暴露其值。
- bundle 只调用 `POST /images/generations`，且只接受 `data[0].b64_json`；它绝不抓取 provider URL。
- 视觉审核使用 OpenAI-compatible `POST /chat/completions`。审核无效、超时或审核网络失败时，会保留已生成图片并停止迭代。
- 图像 POST 发出后，连接中断、超时、非 JSON 或无效图片响应会返回 `IMAGE_GENERATION_OUTCOME_UNKNOWN`。provider 可能已生成并计费，因此 bundle 不会自动重试。
- bundle 不读取 conversation-model credential，也不将 ChatGPT OAuth、Luna Reserve 或订阅视为图像 API access。

## 验证

从 repository root 运行无密钥的 plugin tests：

```sh
node --test image-iterate-plugin/test/*.test.mjs
```

在 Node 24.9+ 且已安装 workspace dependencies 时，运行 assembled Web client composition test：

```sh
pnpm --dir image-iterate-plugin run test:composition
```

composition test 通过 `AppWebEntry` 和 `ModuleLoader` 加载外部 bundle，回放持久化 tool result，并验证标准 gallery 经授权 loader 读取 attachment。它不调用 image provider，也不以 build result 代替 installed-Desktop verification。
