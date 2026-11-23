---
description: "Built-in Web/Desktop bundle for OpenAI-compatible image generation, attachment persistence, visual review, and bounded iteration."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-image-iterate-plugin`

English | [中文](README.zh.md)

## Summary

This bundle adds a built-in `generate_image_with_review` tool to the Web/Desktop composition. It first reads the current chat provider/model and consumes provider-owned image-generation and visual-review closures; it regenerates only when review rejects the image within the configured limit. If either route is missing, the tool reports it before generation. If a provider offers multiple equally ranked generation routes, the tool asks the user to choose. The package is registered by the shipped Web bundle, so users do not install it with `dsh plugin add`.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Provider capability registration](#provider-capability-registration)
- [Failure and cost boundaries](#failure-and-cost-boundaries)
- [Verification](#verification)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Ask for an image in a Web or Desktop conversation. Leave the plugin settings blank to reuse available generation and vision models on the current provider. The saved image appears directly in chat.

<a id="configuration"></a>
## Configuration

The default built-in row contains no endpoint, model, or credential values. An unconfigured installation still loads the plugin and first attempts to inherit the current chat provider. A unique exact capability is selected automatically; when there is no exact match but the provider exposes exactly one capability, that capability is also selected without a prompt. Multiple candidates are presented through user questions, while an unavailable or unanswered selection returns a diagnostic instead of guessing from a model name. Explicit endpoint, model, and credential references remain available as advanced overrides, and each role must be configured as a complete group. Credential fields name POSIX environment variables or DSH credential references; raw secrets remain owned by the provider or credential service and never enter ordinary settings or logs.

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

Each complete override replaces only its role for the current call. The other role still uses the current provider when its override is blank. Override credentials are resolved at execution time; the current provider owns credentials and endpoint selection for automatic routes.

<a id="provider-capability-registration"></a>
## Provider capability registration

Provider plugins register controlled operations through the formal `ImageCapabilityRegistry`; they do not place endpoints or credentials in image-plugin settings. A provider registers generation and, when needed, an independent review route inside a Cordis effect so unloading the provider removes both routes:

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

The plugin reads the current chat provider/model from the agent route. It auto-selects one exact generation route, or the provider's sole route when no exact route exists. Multiple candidates are presented through `ctx.userQuestions.ask`; no candidate or an unanswered prompt produces a diagnostic. For review, a model whose resolved metadata explicitly includes `inputModalities: ['image']` is preferred; otherwise the plugin selects among review routes owned by the same provider and asks when the choice is ambiguous. Capability closures keep provider endpoint and credential handling outside the plugin.

<a id="failure-and-cost-boundaries"></a>
## Failure and cost boundaries

- The image request uses `POST /images/generations` and accepts only `data[0].b64_json`; provider image URLs are not fetched.
- Visual review uses OpenAI-compatible `POST /chat/completions` and requires JSON with `accepted` and `feedback` fields. Review timeout, network failure, or invalid JSON preserves the generated attachment and stops iteration.
- Once an image POST has been sent, a disconnect, timeout, cancellation, non-JSON response, or invalid `b64_json` is reported as `IMAGE_GENERATION_OUTCOME_UNKNOWN`. The provider may have created and charged the image, so the plugin does not retry that request automatically.
- `maxIterations` accepts only 1 through 3. When the limit is reached, the tool returns the last image and review feedback for a later user-directed call.
- Automatic inheritance uses only provider-declared capabilities; it never infers image support from a model name. An undeclared capability produces a diagnostic or a user question.
- The plugin does not automatically treat ChatGPT OAuth, subscription benefits, or Luna Reserve as independent Images API access or quota; availability must be declared by a provider-owned capability.

<a id="verification"></a>
## Verification

The pure HTTP and bounded-iteration tests run with provider mocks:

```sh
pnpm --filter @deepseek-ai/dsh-image-iterate-plugin test
```

The shipped Web composition tests load the actual Web bundle, ModuleLoader/profile registration, provider-owned capability route, attachment loader, and official gallery path:

```sh
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/shipped-composition.e2e.ts
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/image-iterate-client.e2e.ts
```

The shipped provider route uses a test-owned loopback HTTP server and is composition evidence, not a real external provider E2E. A real API E2E remains unverified until a separately authorized provider, credential, and test quota are available; Mock and composition tests cannot substitute for that evidence.

<a id="model-experience"></a>
## Model Experience

### Image generation and review tool

#### What the model sees

The model receives the `generate_image_with_review` tool with required `prompt` and `acceptance_criteria` fields, optional `size` and `quality`, and a result containing the attachment reference, iteration number, acceptance status, review status, and feedback.

#### Token effect

Each request adds one tool schema and the tool result metadata; image bytes remain in the attachment store rather than in the text prompt.

#### KV Cache effect

The tool schema is stable for a fixed profile and plugin version. The result text and attachment metadata vary by request, while changing endpoint, model, credential reference, or iteration settings takes effect when the profile is rebuilt.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The current provider must have compatible generation and vision models.** See [the pi-ai adapter](../../llm/llm-pi-ai/README.md) for the models it recognizes automatically. A missing route is reported before any image request.
- **Real provider compatibility is not established by local tests** — providers must be checked separately for endpoint behavior, model availability, credential permission, quota, and response fields.
- **Review is only as precise as the configured vision model** — the plugin enforces the returned JSON and iteration ceiling, but it cannot guarantee that subjective acceptance criteria are judged correctly.
- **The built-in row has no interactive credential editor** — profile patching or the DSH credential service remains the configuration path.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The Host entry is `src/index.ts`. The client derives the inline image from a successful tool result and uses the standard conversation gallery to load the saved attachment.

</details>
