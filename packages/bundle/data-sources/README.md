---
description: "Read-only data-source bundle for DeepSeek Harness."
kind: "bundle"
---

# Data sources

`@ruyi/dsh-data-sources` is an opt-in, Runtime-independent bundle. It registers four MCP-shaped tools (`data_sources_list`, `data_sources_inspect`, `data_sources_probe`, and `data_sources_read`) and constructs its nine read-only connectors on `apply()`.

## Source configuration

Each source has non-secret coordinates in `connection`, a credential reference in `credentialRef`, and an output/path policy. Credential values are resolved for each probe/read and are never persisted in configuration or returned by tools.

| Kind | Required non-secret connection fields | Credential JSON |
| --- | --- | --- |
| `local-directory` | none (`policy.allowedPath`) | none |
| `s3` / OSS-compatible | `endpoint`, `bucket`, optional `region` (`policy.allowedPrefix`) | `{"accessKeyId":"…","secretAccessKey":"…","sessionToken":"…"}` |
| `sftp` | `host`, optional `port`, `knownHostsPath` (`policy.allowedPath`) | `{"username":"…","privateKey":"…"}` |
| `smb` / `nfs` | administrator-provisioned read-only mount (`policy.allowedPath`) | optional mount credential reference; never mounted by the bundle |
| `ftp` | `host`, optional `port` (`policy.allowedPath`) | `{"username":"…","password":"…"}` |
| `webdav` | HTTPS `endpoint` (`policy.allowedPath`) | `{"username":"…","password":"…"}` |
| `mysql` | `host`, optional `port`, `database` | `{"username":"…","password":"…"}` |
| `postgresql` | `host`, optional `port`, `database` | `{"username":"…","password":"…"}` |

SFTP uses OpenSSH with `StrictHostKeyChecking=yes` and an ephemeral key file removed after each operation. SMB and NFS only traverse an administrator-provisioned mount and never issue mount commands. FTP writes an ephemeral private netrc: every field is quoted and backslash/double-quote escaped, so usernames and passwords may contain spaces and those characters without entering process arguments. FTP rejects CR/LF in credentials because those bytes are unsafe in the FTP control protocol. WebDAV permits HTTPS `PROPFIND` and `GET` only, with platform certificate validation. S3 reads use SigV4 against path-style S3-compatible endpoints. MySQL speaks the classic protocol with `mysql_native_password`; PostgreSQL speaks protocol v3 (trust, clear-text password, and MD5 password authentication).

## Safety rules

- Local, SMB, NFS, FTP, WebDAV, and SFTP reads require a configured absolute path allow-list; local mount paths resolve symlinks before reading, and remote reads receive only the policy-admitted path.
- S3 reads require a configured normalized prefix allow-list.
- MySQL and PostgreSQL allow one `SELECT`, `WITH`, `EXPLAIN`, or `SHOW` statement only. Writes, DDL, `COPY`, semicolons, and MySQL `INTO OUTFILE` / `INTO DUMPFILE` are rejected before transport dispatch.
- Every connector applies concrete `maxBytes` and `maxRows`; a source policy is the upper bound.
- The bundle has no object write, file upload, or database mutation operation.

## Model experience

The model sees source identity, policies, and bounded data only. It does not see credential values or a DSN. `data_sources_probe` verifies an enabled source without returning contents, while `data_sources_read` routes one admitted read to its matching connector.

## Current compatibility boundary

The Host bundle and its Client companion provide the editable Plugins form. The form persists only non-secret coordinates and a credential reference; private key and password values remain in the DSH credential store. Tests exercise FTP through a controlled curl fixture and WebDAV with a local HTTP fixture; production validation requires an HTTPS endpoint, credential reference, and allowed root.
