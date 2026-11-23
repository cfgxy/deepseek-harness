---
description: "Read-only data-source bundle for DeepSeek Harness."
kind: "bundle"
---

# Data sources

`@ruyi/dsh-data-sources` is an opt-in bundle that exposes a source registry, policy guard, and read tools. It has no Runtime dependency and never stores credential values, DSNs, or private keys in bundle configuration.

## Use this bundle

Install the bundle, then configure source metadata and an integration-owned connector for each enabled source. Supported source kinds are `local-directory`, `s3`, `sftp`, `mysql`, and `postgresql`. External sources use a DSH credential reference and resolve it separately for every operation.

The public API is `@ruyi/dsh-data-sources/api` version `v1`. It supplies `ConnectorSupervisor`, `ReadConnector`, and the source/request/result types. Connectors receive only admitted read requests. They must not offer write operations.

## Safety rules

- Local and SFTP reads require a configured path allow-list.
- S3 reads require a configured prefix allow-list.
- MySQL and PostgreSQL admit one `SELECT`, `WITH`, `EXPLAIN`, or `SHOW` statement only; writes, DDL, `COPY`, and semicolon-separated statements are rejected before connector dispatch.
- Result byte and row limits may not exceed source policy.
- Tool output contains source identity and non-secret evidence only.

## Model Experience

### Read tools

#### What the model sees

The bundle contributes `data_sources_list`, `data_sources_inspect`, and `data_sources_read`. The configured source IDs, policy-limited requests, and read results are visible; credential values are not.

#### Token effect

The three tool schemas are included while the bundle is enabled.

#### KV Cache effect

The schemas remain stable until the bundle is enabled or disabled.

## Known Limitations and Deferred Work

- **Deployment connector integration is required** — this minimal bundle supplies registry, policy, credentials, and tool adaptation; production S3/OSS, SFTP, and database MCP process integrations still require dedicated fixture-backed adapters and real service verification.
