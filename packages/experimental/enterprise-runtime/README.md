---
description: "Install a persistent declarative enterprise capability ZIP runtime."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-enterprise-runtime

## Summary

This experimental Host plugin stores validated declarative enterprise ZIP payloads and exposes `runtimeApi: "1"`. It accepts a list template only; ZIP JavaScript and TypeScript are never evaluated.

## Use this package

The companion bundle mounts this Host row. Plugin Manager owns installation and selection of that first-level bundle. This runtime owns its separate `storageDir` and persists package inventory and payloads there.

A second-level ZIP contains `manifest.json` with `id`, `version`, `runtimeApi`, `dependencies`, `permissions`, and `entry`; the entry is a JSON list template. The runtime bounds archive bytes, member count and unpacked bytes, rejects absolute, parent and backslash paths, and accepts only `data.read` permission and `runtimeApi: "1"`.

Activation registers the candidate before disposing the previous active registration. A failed candidate leaves the previous active registration intact. Process restart reloads inventory but intentionally does not automatically activate capabilities.

`DataSourceApi@v1` is optional and is not provided by this package. A template declaring `dataAction: "query"` returns `data-source-unavailable` until an independently-owned provider exists.

## Known Limitations and Deferred Work

- ZIP signing, publisher trust, encryption, malware scanning and strong execution isolation are not implemented.
- `node:vm` is not used or claimed as a security boundary.
- Only the `list` template schema is accepted; no full UI renderer or data source provider is included.
- The POC stores payloads locally and does not implement dependency resolution or cross-process writer locking.
