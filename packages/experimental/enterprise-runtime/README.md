---
description: "Install a persistent declarative enterprise capability ZIP runtime."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-enterprise-runtime

## Summary

This experimental Host plugin stores validated declarative enterprise ZIP payloads and exposes `runtimeApi: "1"`. It accepts list, detail, chart, and report templates only; ZIP JavaScript and TypeScript are never evaluated.

## Use this package

The companion first-level bundle mounts this Host row and a Web contribution beneath its Plugin Manager sidebar detail page. Plugin Manager owns installation and selection of that first-level bundle. The `EnterpriseRuntimeService.api` facade is the v1 Host integration surface; it exposes inventory, activation, uninstallation, and invocation without exposing a Cordis Context or provider object. This runtime owns its separate `storageDir` and persists package inventory and payloads there.

A second-level ZIP contains `manifest.json` with `id`, `version`, `runtimeApi`, `dependencies`, `permissions`, and `entry`; the entry is a JSON list, detail, chart, or report template. Details declare visible fields; charts declare `bar`, `line`, or `pie` plus x/y fields; reports declare ordered sections. The runtime bounds archive bytes, member count and unpacked bytes, rejects absolute, parent and backslash paths, and accepts only `data.read` permission and `runtimeApi: "1"`.

Activation registers the candidate before disposing the previous active registration. A failed candidate leaves the previous active registration intact. Process restart reloads inventory but intentionally does not automatically activate capabilities.

Each active package is registered as a real Harness `ctx.tools` tool; disposing, replacing or uninstalling it removes that registration. `DataSourceApi@v1` is discovered only through the optional public Cordis service key `dataSourceApi` (`apiVersion: "1"`), and is not provided by this package. Its query and row values must be lossless JSON so the model-facing tool result remains durable. A template declaring `dataAction: "query"` may include a JSON-safe `query` object and returns `data-source-unavailable` until an independently-owned provider exists. The bundled Langfuse example is only a question-shaped report query (`source: "langfuse"`); it neither bundles nor configures a Langfuse connector.

## Known Limitations and Deferred Work

- List, detail, chart, and report schemas are deliberately small prototypes, not a full UI renderer.
- ZIP signing, publisher trust, encryption, malware scanning and strong execution isolation are not implemented.
- `node:vm` is not used or claimed as a security boundary.
- No full UI renderer or data source provider is included; the Plugin Manager sidebar contribution is a declarative prototype guide.
- The POC stores payloads locally and does not implement dependency resolution or cross-process writer locking.
