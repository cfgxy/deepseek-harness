/** Validate the assembled application, including native Office conversion outside ASAR. */
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { desktopArtifactOutput, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { resolveDesktopPackageTarget } from './package-target.ts'

/**
 * 解析用于验证解包运行时的可执行文件。
 * @param application 解包后的 Windows 应用目录或 macOS Contents 目录。
 * @param windows 所选包是否为 Windows 包。
 * @param environment 选择打包模式的环境。
 * @returns electron-builder 为所选产品身份输出的精确可执行文件。
 */
export function resolvePackagedRuntimeExecutable(
  application: string,
  windows: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (!windows) return join(application, 'MacOS', 'DeepSeek Harness')
  return join(application, environment.DSH_DESKTOP_HOSTED_UNSIGNED === '1'
    ? 'DeepSeek Harness Internal Test.exe'
    : 'DeepSeek Harness.exe')
}

async function main(): Promise<void> {
  const paths = resolveDesktopTargetBuildPaths()
  const { values } = parseArgs({ options: { unsigned: { type: 'boolean', default: false }, 'skip-notarization': { type: 'boolean', default: false } }, allowPositionals: false })
  const target = resolveDesktopBuildTarget()
  const windows = target === 'win-x64'
  const artifacts = desktopArtifactOutput(paths, { unsigned: values.unsigned, skipNotarization: values['skip-notarization'] }).directory
  const application = windows ? join(artifacts, 'win-unpacked')
    : join(artifacts, target === 'mac-arm64' ? 'mac-arm64' : 'mac', 'DeepSeek Harness.app', 'Contents')
  const resources = join(application, windows ? 'resources' : 'Resources')
  const executable = resolvePackagedRuntimeExecutable(application, windows)
  const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version,
    resolveDesktopPackageTarget(target))
  if (windows && !values.unsigned) await verifyWindowsCode(application)
  await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), executable, join(resources, 'runtime'), descriptor)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
