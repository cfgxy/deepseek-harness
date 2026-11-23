---
description: "内置 Web/Desktop bundle，提供 OpenAI-compatible 图像生成、附件持久化、视觉审核与有限轮次迭代。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-image-iterate-plugin`

[English](README.md) | 中文

## 概述

本组合包为 Web/Desktop 组合提供内置的 `generate_image_with_review` 工具。它优先读取当前聊天的 provider/model，并通过 provider-owned capability 获取受控的图像生成和视觉审核 closure；只有审核拒绝且未达到配置上限时才会再次生成。缺少任一路由时，工具会在生图前报告；同一 provider 有多个同等优先的生图路由时，工具才会请用户选择。该 package 由随附的 Web bundle 注册，因此用户不需要执行 `dsh plugin add`。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [Provider capability 注册](#provider-capability-registration)
- [失败与费用边界](#failure-and-cost-boundaries)
- [验证](#verification)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Web 或 Desktop 对话里直接提出生图请求。插件设置留空时，使用当前 provider 已有的生图和视觉模型。保存后的图片直接显示在聊天中。

<a id="configuration"></a>
## 配置

默认内置配置项不包含 endpoint、model 或 credential 值。未配置的安装仍会加载插件，工具会优先继承当前聊天 provider。model 完全匹配时，如果只有一个 exact capability 会自动选择；没有 exact 匹配但该 provider 只有一个 capability 时，也会自动选择而不发起问询。存在多个候选时通过用户问询选择；没有候选或问询没有答案时返回诊断，而不是按模型名称猜测。显式 endpoint、model 和 credential reference 仍可作为高级覆盖，且每个覆盖角色必须成组填写。credential 字段填写 POSIX 环境变量名或 DSH credential reference，不是密钥值；原始密钥只由 provider 或 credential service 持有，不会进入普通 settings 或日志。

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

每组完整覆盖只替换本次调用中对应的角色。另一组留空时，该角色继续使用当前 provider。显式覆盖的凭据在执行时解析；自动路由的凭据和地址由当前 provider 管理。

<a id="provider-capability-registration"></a>
## Provider capability 注册

Provider 插件通过正式的 `ImageCapabilityRegistry` 注册受控操作，不把 endpoint 或凭据写入 image 插件配置。Provider 应在 Cordis effect 中注册图像生成和必要的独立审核路由；卸载 provider 时，effect 会移除对应路由：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { provideImageCapabilityRegistry } from '@deepseek-ai/dsh-image-iterate-plugin'
import type { ImageCapability } from '@deepseek-ai/dsh-image-iterate-plugin'

declare const ctx: Context
declare const providerGenerate: ImageCapability['generate']
declare const providerReview: NonNullable<ImageCapability['review']>

const registry = provideImageCapabilityRegistry(ctx)
ctx.effect(() => registry.register({
  id: 'provider-image-route',
  provider: 'provider-id',
  model: 'declared-image-model',
  label: 'Provider image route',
  generate: providerGenerate,
  review: providerReview,
}))
```

插件从 agent 路由读取当前聊天 provider/model。它会自动选择一个 exact 图像生成路由；没有 exact 路由但 provider 只有一个路由时也会自动选择。存在多个候选时通过 `ctx.userQuestions.ask` 询问用户；没有候选或问询没有答案时返回诊断。视觉审核方面，只有解析后的模型 metadata 明确包含 `inputModalities: ['image']` 时才优先复用当前模型；否则从同一 provider 所有审核路由中选择，无法安全决策时询问用户。Capability closure 将 provider 的 endpoint 和凭据处理留在插件之外。

<a id="failure-and-cost-boundaries"></a>
## 失败与费用边界

- 图像请求使用 `POST /images/generations`，只接受 `data[0].b64_json`；不会抓取 provider 返回的图片 URL。
- 视觉审核使用 OpenAI-compatible `POST /chat/completions`，要求 JSON 中包含 `accepted` 与 `feedback` 字段。审核超时、网络失败或 JSON 无效时保留已生成的附件并停止迭代。
- 图像 POST 发出后，如果连接中断、超时、取消、响应不是 JSON 或 `b64_json` 无效，会报告 `IMAGE_GENERATION_OUTCOME_UNKNOWN`。provider 可能已经生成并计费，因此插件不会自动重试该请求。
- `maxIterations` 只接受 1 到 3。达到上限后，工具返回最后一张图片和审核反馈，用户可以之后主动发起新的调用。
- 自动继承只使用 provider 明确注册的 capability，不根据模型名称推断图像能力；当前 provider 未声明 capability 时会返回诊断或发起问询。
- 插件不会把 ChatGPT OAuth、订阅权益或 Luna Reserve 自动当作独立 Images API 权限或额度；是否可用由 provider-owned capability 明确声明。

<a id="verification"></a>
## 验证

纯 HTTP 与有限迭代测试使用 provider mock：

```sh
pnpm --filter @deepseek-ai/dsh-image-iterate-plugin test
```

随附的 Web 组合测试会加载实际 Web bundle、ModuleLoader/profile 注册、provider-owned capability 路由、attachment loader 与官方 gallery 路径：

```sh
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/shipped-composition.e2e.ts
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/image-iterate-client.e2e.ts
```

shipped provider 路由使用测试自有的 loopback HTTP server，只能作为组合证据，不能作为真实外部 provider E2E。只有在获得独立授权的 provider、凭据和测试额度后，才能另行执行真实 API E2E；Mock 和组合测试不能替代该证据。

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

- **当前 provider 必须有兼容的生图与视觉模型。** 支持自动识别的模型见 [pi-ai 适配器](../../llm/llm-pi-ai/README.zh.md)。任一角色缺失时，工具会在发出生图请求前报告。
- **本地测试不能证明真实 provider 兼容性**：仍需单独核对 provider 的 endpoint 行为、模型可用性、凭据权限、额度和响应字段。
- **审核精度取决于配置的视觉模型**：插件会强制校验返回 JSON 并限制迭代次数，但不能保证主观验收标准一定被正确判断。
- **内置配置项没有交互式凭据编辑器**：配置路径仍是 profile patch 或 DSH credential service。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

Host 入口是 `src/index.ts`。客户端根据成功的工具结果显示图片，并通过标准聊天预览加载已保存的附件。

</details>
