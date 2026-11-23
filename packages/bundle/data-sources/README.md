---
description: "Read-only data-source bundle for DeepSeek Harness."
kind: "bundle"
---

# Data sources

`@ruyi/dsh-data-sources` is an opt-in, Runtime-independent bundle. It registers four MCP-shaped tools (`data_sources_list`, `data_sources_inspect`, `data_sources_probe`, and `data_sources_read`) and constructs its five read-only connectors on `apply()`.

## Source configuration

Each source has non-secret coordinates in `connection`, a credential reference in `credentialRef`, and an output/path policy. Credential values are resolved for each probe/read and are never persisted in configuration or returned by tools.

| Kind | Required non-secret connection fields | Credential JSON |
| --- | --- | --- |
| `local-directory` | none (`policy.allowedPath`) | none |
| `s3` / OSS-compatible | `endpoint`, `bucket`, optional `region` (`policy.allowedPrefix`) | `{"accessKeyId":"…","secretAccessKey":"…","sessionToken":"…"}` |
| `sftp` | `host`, optional `port`, `knownHostsPath` (`policy.allowedPath`) | `{"username":"…","privateKey":"…"}` |
| `mysql` | `host`, optional `port`, `database` | `{"username":"…","password":"…"}` |
| `postgresql` | `host`, optional `port`, `database` | `{"username":"…","password":"…"}` |

SFTP uses OpenSSH with `StrictHostKeyChecking=yes` and an ephemeral key file removed after each operation. S3 reads use SigV4 against path-style S3-compatible endpoints. MySQL speaks the classic protocol with `mysql_native_password`; PostgreSQL speaks protocol v3 (trust, clear-text password, and MD5 password authentication).

## Safety rules

- Local and SFTP reads require a configured absolute path allow-list and resolve symlinks before reading.
- S3 reads require a configured normalized prefix allow-list.
- MySQL and PostgreSQL allow one `SELECT`, `WITH`, `EXPLAIN`, or `SHOW` statement only. Writes, DDL, `COPY`, semicolons, and MySQL `INTO OUTFILE` / `INTO DUMPFILE` are rejected before transport dispatch.
- Every connector applies concrete `maxBytes` and `maxRows`; a source policy is the upper bound.
- The bundle has no object write, file upload, or database mutation operation.

## Model experience

The model sees source identity, policies, and bounded data only. It does not see credential values or a DSN. `data_sources_probe` verifies an enabled source without returning contents, while `data_sources_read` routes one admitted read to its matching connector.

## Current compatibility boundary

The connector implementations are host-side. A separate Client companion is needed to render an editable Plugins form; exposing private key or password fields through that form is intentionally out of scope for this package and must use the DSH credential picker.
