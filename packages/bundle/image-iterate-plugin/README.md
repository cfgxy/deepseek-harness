---
description: "Built-in Web/Desktop bundle for OpenAI-compatible image generation, attachment persistence, visual review, and bounded iteration."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-image-iterate-plugin`

English | [中文](README.zh.md)

## Summary

This bundle adds a built-in `generate_image_with_review` tool to the Web/Desktop composition. It sends image requests to a configured OpenAI-compatible Images API, saves returned `b64_json` bytes through the Harness attachment service, asks an independently configured vision model to check explicit acceptance criteria, and generates again only when the review rejects the image within the configured limit. The package is registered by the shipped Web bundle, so users do not install it with `dsh plugin add`.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Failure and cost boundaries](#failure-and-cost-boundaries)
- [Verification](#verification)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Web/Desktop shipped bundle always includes the plugin row. Configure the existing `image-iterate-plugin` row in the target profile's `cordis.patch.yml`; do not add a second plugin row or copy a secret into the patch.

<a id="configuration"></a>
## Configuration

The default built-in row contains no endpoint, model, or credential values. An unconfigured installation still loads the plugin, and the first tool call returns `MISSING_CONFIG` instead of silently omitting the capability. Credential fields name POSIX environment variables or DSH credential references; they are not secret values.

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

The image and review credentials are resolved on every tool call, so credential rotation does not require a process restart. Keep the two references independent when image generation and visual review should have different access or audit scopes.

<a id="failure-and-cost-boundaries"></a>
## Failure and cost boundaries

- The image request uses `POST /images/generations` and accepts only `data[0].b64_json`; provider image URLs are not fetched.
- Visual review uses OpenAI-compatible `POST /chat/completions` and requires JSON with `accepted` and `feedback` fields. Review timeout, network failure, or invalid JSON preserves the generated attachment and stops iteration.
- Once an image POST has been sent, a disconnect, timeout, cancellation, non-JSON response, or invalid `b64_json` is reported as `IMAGE_GENERATION_OUTCOME_UNKNOWN`. The provider may have created and charged the image, so the plugin does not retry that request automatically.
- `maxIterations` accepts only 1 through 3. When the limit is reached, the tool returns the last image and review feedback for a later user-directed call.
- The plugin does not reuse the conversation model credential and does not treat ChatGPT OAuth, subscription benefits, or Luna Reserve as Images API access or quota.

<a id="verification"></a>
## Verification

The pure HTTP and bounded-iteration tests run with provider mocks:

```sh
node --test packages/bundle/image-iterate-plugin/test/*.test.mjs
```

The shipped Web composition test loads the actual Web bundle, ModuleLoader registration, attachment loader, and official gallery path:

```sh
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/image-iterate-client.e2e.ts
```

This composition test does not call a real Images API or vision provider. A real API E2E remains unverified until a separately authorized provider, credential, and test quota are available; Mock and composition tests cannot substitute for that evidence.

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

- **Real provider compatibility is not established by local tests** — providers must be checked separately for endpoint behavior, model availability, credential permission, quota, and response fields.
- **Review is only as precise as the configured vision model** — the plugin enforces the returned JSON and iteration ceiling, but it cannot guarantee that subjective acceptance criteria are judged correctly.
- **The built-in row has no interactive credential editor** — profile patching or the DSH credential service remains the configuration path.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The Host protocol surface is `src/index.ts`; the existing JavaScript implementation is imported from `src/plugin.js` so its error-path tests continue to exercise the production registration logic. `client.js` remains a Harness classic-script ModuleLoader factory and delegates image rendering to the official conversation gallery.

</details>
