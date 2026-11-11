---
description: "内置 Web/Desktop bundle，提供 OpenAI-compatible 图像生成、附件持久化、视觉审核与有限轮次迭代。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-image-iterate-plugin`

[English](README.md) | 中文

## 概述

本组合包为 Web/Desktop 组合提供内置的 `generate_image_with_review` 工具。它调用配置的 OpenAI-compatible Images API，使用 Harness attachment 服务保存返回的 `b64_json` 字节，再让独立配置的视觉模型按照显式验收标准检查图片；只有审核拒绝且未达到配置上限时才会再次生成。该 package 由随附的 Web bundle 注册，因此用户不需要执行 `dsh plugin add`。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [失败与费用边界](#failure-and-cost-boundaries)
- [验证](#verification)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

随附的 Web/Desktop bundle 始终包含该插件配置项。在目标 profile 的 `cordis.patch.yml` 中配置已有的 `image-iterate-plugin` 配置项；不要添加第二个插件配置项，也不要把密钥复制到 patch 中。

<a id="configuration"></a>
## 配置

默认内置配置项不包含 endpoint、model 或 credential 值。未配置的安装仍会加载插件，第一次工具调用会返回 `MISSING_CONFIG`，不会静默省略能力。credential 字段填写 POSIX 环境变量名或 DSH credential reference，不是密钥值。

```yaml
- id: image-iterate-plugin
  name: '@deepseek-ai/dsh-image-iterate-plugin'
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

插件在每次工具调用时重新解析图像和审核凭据，因此凭据轮换无需重启进程。如果图像生成与视觉审核需要不同的访问权限或审计范围，应保持两个引用独立。

<a id="failure-and-cost-boundaries"></a>
## 失败与费用边界

- 图像请求使用 `POST /images/generations`，只接受 `data[0].b64_json`；不会抓取 provider 返回的图片 URL。
- 视觉审核使用 OpenAI-compatible `POST /chat/completions`，要求 JSON 中包含 `accepted` 与 `feedback` 字段。审核超时、网络失败或 JSON 无效时保留已生成的附件并停止迭代。
- 图像 POST 发出后，如果连接中断、超时、取消、响应不是 JSON 或 `b64_json` 无效，会报告 `IMAGE_GENERATION_OUTCOME_UNKNOWN`。provider 可能已经生成并计费，因此插件不会自动重试该请求。
- `maxIterations` 只接受 1 到 3。达到上限后，工具返回最后一张图片和审核反馈，用户可以之后主动发起新的调用。
- 插件不会复用当前对话模型凭据，也不会把 ChatGPT OAuth、订阅权益或 Luna Reserve 当作 Images API 权限或额度。

<a id="verification"></a>
## 验证

纯 HTTP 与有限迭代测试使用 provider mock：

```sh
node --test packages/bundle/image-iterate-plugin/test/*.test.mjs
```

随附的 Web 组合测试会加载实际 Web bundle、ModuleLoader 注册、attachment loader 与官方 gallery 路径：

```sh
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/image-iterate-client.e2e.ts
```

该组合测试不会调用真实 Images API 或视觉 provider。只有在获得独立授权的 provider、凭据和测试额度后，才能另行执行真实 API E2E；Mock 和组合测试不能替代该证据。

<a id="model-experience"></a>
## 模型体验

### 图像生成与审核工具

#### 模型看到什么

模型会收到 `generate_image_with_review` 工具，其中 `prompt` 与 `acceptance_criteria` 为必填字段，`size` 与 `quality` 为可选字段；结果包含附件引用、迭代次数、接受状态、审核状态和反馈。

#### Token 影响

每次请求增加一个工具 schema 和工具结果 metadata；图片字节保存在 attachment store 中，不会进入文本 prompt。

#### KV Cache 影响

固定 profile 与插件版本下，工具 schema 保持稳定。结果文本和附件 metadata 随请求变化；endpoint、model、credential reference 或迭代设置的变更会在重新构建 profile 后生效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **本地测试不能证明真实 provider 兼容性**：仍需单独核对 provider 的 endpoint 行为、模型可用性、凭据权限、额度和响应字段。
- **审核精度取决于配置的视觉模型**：插件会强制校验返回 JSON 并限制迭代次数，但不能保证主观验收标准一定被正确判断。
- **内置配置项没有交互式凭据编辑器**：配置路径仍是 profile patch 或 DSH credential service。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

Host 协议入口是 `src/index.ts`；现有 JavaScript 实现从 `src/plugin.js` 导入，以便错误路径测试继续覆盖生产注册逻辑。`client.js` 仍是 Harness classic-script ModuleLoader factory，并将图片呈现交给官方 conversation gallery。

</details>
