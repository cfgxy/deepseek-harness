# Image generation and review

English | [中文](README.zh.md)

This bundle gives DeepSeek Harness the `generate_image_with_review` tool. It sends an OpenAI-compatible image-generation request, asks a separately configured vision model to check the result against the supplied acceptance criteria, and saves the accepted image as a Harness attachment.

## Desktop setup

Windows Internal Test Desktop ships this bundle with its local runtime, so it does not need a source checkout or a plugin installation command. Open **Plugins** in Settings, select **Image generation and review**, and save the provider settings there.

The normal fields are `imageBaseUrl`, `imageModel`, `imageCredential`, `reviewBaseUrl`, `reviewModel`, `reviewCredential`, `maxIterations`, `timeoutMs`, `defaultSize`, `defaultQuality`, and `outputFormat`. Credential fields name a POSIX-compatible reference; they are not secret values. `maxIterations` accepts 1 through 3, `timeoutMs` must be at least 1000, and `outputFormat` accepts `png`, `webp`, or `jpeg`.

Enter each API key in its matching password field. The Desktop writes it through the credentials service instead of the settings file, and the screen only reports whether the named reference is configured and writable. Leave a password field blank to retain its current value.

After saving, ask for an image in a normal conversation and include the acceptance criteria. The agent can discover and call `generate_image_with_review`; the final attachment renders in the standard conversation image gallery. This bundle adds no separate image-generation page and does not change the agent loop.

## Profile configuration

Non-Desktop profiles can add the local bundle, then configure the same non-secret fields in their profile patch. The credential references below are names only.

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

Configure the referenced credentials through the DSH credentials service or the launch environment. Do not put a key in `cordis.patch.yml`, an Issue, a log, or a screenshot. Each tool call resolves credentials again, so key rotation does not require a restart.

## Failure and limits

- Missing normal configuration returns a structured `MISSING_CONFIG` failure that points to Desktop Settings or the profile patch.
- A missing credential returns a structured `MISSING_CREDENTIAL` failure without exposing its value.
- The bundle calls only `POST /images/generations` and accepts only `data[0].b64_json`; it never fetches a provider URL.
- Visual review uses OpenAI-compatible `POST /chat/completions`. An invalid review, timeout, or review network failure retains the generated image and stops iteration.
- After an image POST is sent, an interrupted, timed-out, non-JSON, or invalid-image response returns `IMAGE_GENERATION_OUTCOME_UNKNOWN`. The provider may have generated and billed an image, so the bundle does not retry automatically.
- The bundle does not read the conversation-model credential and does not treat ChatGPT OAuth, Luna Reserve, or a subscription as image API access.

## Verification

Run the keyless plugin tests from the repository root:

```sh
node --test image-iterate-plugin/test/*.test.mjs
```

Run the assembled Web client composition test on Node 24.9+ with workspace dependencies installed:

```sh
pnpm --dir image-iterate-plugin run test:composition
```

The composition test loads the external bundle through `AppWebEntry` and `ModuleLoader`, replays a durable tool result, and verifies that the standard gallery reads the attachment through the authorized loader. It does not call an image provider or substitute a build result for installed-Desktop verification.
