import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, chmodSync, rmSync, readdirSync, copyFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, delimiter } from 'node:path'
import os from 'node:os'
import type { DataSourcesEnvStatus, DataSourcesInstallResult } from './api.ts'

const execFileAsync = promisify(execFile)

/** Domestic mirror endpoints for fast access in China. */
export const CHINA_MIRRORS = {
  pythonBuild: 'https://mirrors.tuna.tsinghua.edu.cn/github-release/indygreg/python-build-standalone',
  pypiIndex: 'https://mirrors.aliyun.com/pypi/simple/',
  pypiTrustedHost: 'mirrors.aliyun.com',
  uvZipWinX64: [
    'https://mirror.ghproxy.com/https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip',
    'https://ghproxy.net/https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip',
    'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip',
  ],
  uvTarLinuxX64: [
    'https://mirror.ghproxy.com/https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz',
    'https://ghproxy.net/https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz',
    'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz',
  ],
  uvTarMacArm64: [
    'https://mirror.ghproxy.com/https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz',
    'https://ghproxy.net/https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz',
    'https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz',
  ],
  uvTarMacX64: [
    'https://mirror.ghproxy.com/https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz',
    'https://ghproxy.net/https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz',
    'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz',
  ],
}

/** Resolve the executable path of uv from bundle bin, home directories, or PATH. */
export async function resolveUvPath(pythonCwd: string, configuredCommand?: string): Promise<string | undefined> {
  const isWin = process.platform === 'win32'
  const uvBinary = isWin ? 'uv.exe' : 'uv'
  const candidates: string[] = []

  if (configuredCommand && configuredCommand !== 'uv') candidates.push(configuredCommand)

  // Local bundle directories
  candidates.push(join(pythonCwd, 'bin', uvBinary))
  candidates.push(join(pythonCwd, '.venv', isWin ? 'Scripts' : 'bin', uvBinary))

  // User home directories
  const home = os.homedir()
  if (isWin) {
    candidates.push(join(home, '.local', 'bin', 'uv.exe'))
    candidates.push(join(home, '.cargo', 'bin', 'uv.exe'))
  } else {
    candidates.push(join(home, '.local', 'bin', 'uv'))
    candidates.push(join(home, '.cargo', 'bin', 'uv'))
  }

  // System PATH
  candidates.push('uv')

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['--version'])
      return candidate
    } catch {
      // not available
    }
  }
  return undefined
}

/** Check environment status: whether python, uv, and the MCP runtime are available. */
export async function checkEnvironment(pythonCwd: string, configuredCommand?: string): Promise<DataSourcesEnvStatus> {
  const uvPath = await resolveUvPath(pythonCwd, configuredCommand)
  const hasUv = uvPath !== undefined

  let hasPython = false
  for (const py of ['python3', 'python']) {
    try {
      await execFileAsync(py, ['--version'])
      hasPython = true
      break
    } catch {
      // continue
    }
  }

  let mcpRunning = false
  if (uvPath) {
    try {
      await execFileAsync(uvPath, ['run', '--frozen', 'python', '-c', 'import duckdb, mcp'], { cwd: pythonCwd })
      mcpRunning = true
    } catch {
      // dependencies not yet prepared
    }
  }

  return {
    hasPython,
    hasUv,
    mcpRunning,
    ...(uvPath ? { uvPath } : {}),
  }
}

async function downloadFromMirrors(urls: string[], destination: string, signal?: AbortSignal): Promise<void> {
  let lastError: unknown
  for (const url of urls) {
    if (signal?.aborted) throw new Error('Installation was cancelled')
    try {
      const response = await fetch(url, signal ? { signal, redirect: 'follow' } : { redirect: 'follow' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      await writeFile(destination, buffer)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`Failed to download uv from mirrors: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function extractArchive(archivePath: string, destinationDir: string): Promise<void> {
  mkdirSync(destinationDir, { recursive: true })
  if (process.platform === 'win32') {
    try {
      await execFileAsync('tar', ['-xf', archivePath, '-C', destinationDir])
      return
    } catch {
      await execFileAsync('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destinationDir}' -Force`,
      ])
    }
  } else {
    if (archivePath.endsWith('.zip')) {
      await execFileAsync('unzip', ['-o', archivePath, '-d', destinationDir])
    } else {
      await execFileAsync('tar', ['-xzf', archivePath, '-C', destinationDir])
    }
  }
}

/** Search destination directory and subdirectories for the uv binary and promote it to binDir. */
function locateAndPromoteUv(binDir: string): string | undefined {
  const isWin = process.platform === 'win32'
  const uvBinary = isWin ? 'uv.exe' : 'uv'
  const directPath = join(binDir, uvBinary)
  if (existsSync(directPath)) {
    if (!isWin) try { chmodSync(directPath, 0o755) } catch {}
    return directPath
  }

  // Scan 1 level of subdirectories (e.g. uv-x86_64-pc-windows-msvc/uv.exe)
  try {
    const entries = readdirSync(binDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nested = join(binDir, entry.name, uvBinary)
        if (existsSync(nested)) {
          // move or copy to binDir
          copyFileSync(nested, directPath)
          if (!isWin) try { chmodSync(directPath, 0o755) } catch {}
          return directPath
        }
      }
    }
  } catch {}
  return undefined
}

/** One-click installation of uv, standalone Python (if needed), and MCP dependencies via China mirrors. */
export async function installEnvironment(pythonCwd: string, signal?: AbortSignal): Promise<DataSourcesInstallResult> {
  const binDir = join(pythonCwd, 'bin')
  mkdirSync(binDir, { recursive: true })

  let uvPath = await resolveUvPath(pythonCwd)

  if (!uvPath) {
    // 1. Try pip install uv if python/pip is available
    for (const py of ['python3', 'python']) {
      try {
        await execFileAsync(py, ['-m', 'pip', 'install', 'uv', '-i', CHINA_MIRRORS.pypiIndex, '--trusted-host', CHINA_MIRRORS.pypiTrustedHost], { signal })
        uvPath = await resolveUvPath(pythonCwd)
        if (uvPath) break
      } catch {}
    }
  }

  if (!uvPath) {
    // 2. Download standalone uv binary from domestic mirror
    const isWin = process.platform === 'win32'
    const isMac = process.platform === 'darwin'
    const isArm = process.arch === 'arm64'

    let urls: string[]
    let ext: string
    if (isWin) {
      urls = CHINA_MIRRORS.uvZipWinX64
      ext = '.zip'
    } else if (isMac) {
      urls = isArm ? CHINA_MIRRORS.uvTarMacArm64 : CHINA_MIRRORS.uvTarMacX64
      ext = '.tar.gz'
    } else {
      urls = CHINA_MIRRORS.uvTarLinuxX64
      ext = '.tar.gz'
    }

    const tempArchive = join(binDir, `uv-download-${Date.now()}${ext}`)
    try {
      await downloadFromMirrors(urls, tempArchive, signal)
      await extractArchive(tempArchive, binDir)
      uvPath = locateAndPromoteUv(binDir)
    } finally {
      rmSync(tempArchive, { force: true })
    }
  }

  if (!uvPath) {
    return { ok: false, message: '未能自动安装 uv 工具，请检查网络连接或手动安装 uv。' }
  }

  // 3. Use uv to sync dependencies and provision Python from domestic mirrors
  const mirrorEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    UV_PYTHON_INSTALL_MIRROR: CHINA_MIRRORS.pythonBuild,
    UV_INDEX_URL: CHINA_MIRRORS.pypiIndex,
    UV_DEFAULT_INDEX: CHINA_MIRRORS.pypiIndex,
    PIP_INDEX_URL: CHINA_MIRRORS.pypiIndex,
    PATH: `${binDir}${delimiter}${process.env.PATH || ''}`,
  }

  try {
    await execFileAsync(uvPath, ['sync', '--frozen'], { cwd: pythonCwd, env: mirrorEnv, signal })
    return { ok: true, message: 'uv 与 Python 依赖已通过国内镜像源成功安装！' }
  } catch (_syncError) {
    // Fallback: try uv run without frozen to populate venv
    try {
      await execFileAsync(uvPath, ['pip', 'install', '-e', '.', '-i', CHINA_MIRRORS.pypiIndex], { cwd: pythonCwd, env: mirrorEnv, signal })
      return { ok: true, message: 'Python 依赖已通过国内 PyPI 镜像成功安装！' }
    } catch (fallbackError) {
      const msg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      return { ok: false, message: `依赖安装失败: ${msg}` }
    }
  }
}
