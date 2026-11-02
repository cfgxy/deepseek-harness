# 图像生成与核验插件

此 bundle 为 DeepSeek Harness 注册 `generate_image_with_review` 工具。工具使用一个 OpenAI-compatible Images API 生成图片，再使用另一个配置的视觉模型按验收标准检查结果；仅当视觉模型明确返回不通过时，才会在 `maxIterations` 上限内重新生成。图片通过 Harness attachment 服务保存并显示在工具结果旁。

## 安装

在 Node 24.9+ 且已安装 DSH 的环境中，在包含本目录的目录执行：

```sh
dsh plugin --profile web add ./image-iterate-plugin
```

随后在 `$DSH_HOME/profiles/web/cordis.patch.yml` 覆盖本 bundle 的配置。凭据字段是 POSIX 环境变量名称，不是密钥值：

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

通过 DSH 凭据服务或启动环境配置 `IMAGE_API_KEY` 和 `VISION_API_KEY`。不要将密钥写入 `cordis.patch.yml`、Issue、日志或截图。插件每次工具调用都重新解析凭据，因此凭据轮换无需重启。图像和视觉审核可使用同一上游，但保持独立凭据引用可以限制权限和审计范围。

## 边界

- 仅调用 `POST /images/generations`，且只接受 `data[0].b64_json`；不会抓取 provider 返回的 URL。
- 视觉审核调用 OpenAI-compatible `POST /chat/completions`，要求 JSON 结果。审核网络错误、超时或 JSON 无效时保留已生成图片并停止，不会重发可能已产生费用的图像请求；图像请求连接中断、超时或取消后会以 `UPSTREAM_OUTCOME_UNKNOWN` 失败并明确声明不可自动重试。
- 本插件不读取 Harness 当前对话模型凭据，不使用 ChatGPT OAuth、Luna Reserve 或订阅权益，也不验证账户是否拥有图像 API 额度。
- `maxIterations` 仅接受 1 到 3。达到上限仍不通过时，工具返回最后一张图片和审核反馈，由用户决定是否再次发起新调用。

## 核验

纯 HTTP、审核和有限迭代逻辑不依赖 DSH，可在 Node 22 运行 Mock 测试：

```sh
node --test image-iterate-plugin/test/*.test.mjs
```

本机 Node 22 不满足 Harness 源码要求的 Node 24.9，未执行 Harness 启动、安装验证或真实 API 请求；安装命令依据 Harness 的 bundle 文档编写，仍需在目标环境复核。`client.js` 是 Harness classic-script module-loader 工厂产物，不要改为浏览器原生 ESM 文件。
