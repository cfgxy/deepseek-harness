/** Locale bundles for the image generation and review settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys rendered by the image settings page. */
export type ImageIterateSettingsLocaleKey =
  | 'title' | 'description'
  | 'imageBaseUrl' | 'imageModel' | 'imageCredential'
  | 'reviewBaseUrl' | 'reviewModel' | 'reviewCredential' | 'overrideHint'
  | 'imageSecret' | 'reviewSecret' | 'secretHint'
  | 'configured' | 'unconfigured' | 'credentialUnknown'
  | 'maxIterations' | 'timeoutMs' | 'defaultSize' | 'defaultQuality' | 'outputFormat'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed' | 'invalidNumber' | 'invalidFormat' | 'invalidIterations' | 'invalidTimeout'

/** English copy. */
export const en: Record<ImageIterateSettingsLocaleKey, string> = {
  title: 'Image generation and review', description: 'The tool inherits the current chat provider when a provider-owned image capability is available. The fields below are advanced overrides.',
  imageBaseUrl: 'Image override API base URL', imageModel: 'Image override model', imageCredential: 'Image override credential reference',
  reviewBaseUrl: 'Review override API base URL', reviewModel: 'Review override model', reviewCredential: 'Review override credential reference',
  overrideHint: 'Leave all override fields blank to inherit the current chat provider. Set endpoint, model, and credential reference together for an advanced override.',
  imageSecret: 'Image API key', reviewSecret: 'Review API key', secretHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  configured: 'A key is configured.', unconfigured: 'No key is configured.', credentialUnknown: 'Credential status is unavailable.',
  maxIterations: 'Maximum iterations', timeoutMs: 'Request timeout (ms)', defaultSize: 'Default image size', defaultQuality: 'Default quality', outputFormat: 'Output format',
  overridden: 'Overridden', reset: 'Reset to default', readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.', save: 'Save', saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.', invalidNumber: 'Enter a whole number in the accepted range.',
  invalidFormat: 'Choose png, webp, or jpeg.', invalidIterations: 'Enter an integer from 1 to 3.', invalidTimeout: 'Enter an integer of at least 1000.',
}

/** Simplified Chinese copy. */
export const zh: Record<ImageIterateSettingsLocaleKey, string> = {
  title: '图像生成与审核', description: '如果当前聊天 provider 提供受控图像能力，工具会自动继承；下方字段用于高级覆盖。',
  imageBaseUrl: '图像覆盖 API 基础地址', imageModel: '图像覆盖模型', imageCredential: '图像覆盖凭据引用',
  reviewBaseUrl: '审核覆盖 API 基础地址', reviewModel: '审核覆盖模型', reviewCredential: '审核覆盖凭据引用',
  overrideHint: '全部覆盖字段留空时继承当前聊天 provider。高级覆盖必须同时填写 endpoint、model 和凭据引用。',
  imageSecret: '图像 API Key', reviewSecret: '审核 API Key', secretHint: '不写入设置文件。留空表示保持当前密钥。',
  configured: '已配置密钥。', unconfigured: '未配置密钥。', credentialUnknown: '无法读取凭据状态。',
  maxIterations: '最大迭代次数', timeoutMs: '请求超时（毫秒）', defaultSize: '默认图片尺寸', defaultQuality: '默认质量', outputFormat: '输出格式',
  overridden: '已覆盖', reset: '恢复默认', readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。', save: '保存', saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。', invalidNumber: '请输入受支持范围内的整数。',
  invalidFormat: '请选择 png、webp 或 jpeg。', invalidIterations: '请输入 1 到 3 的整数。', invalidTimeout: '请输入不小于 1000 的整数。',
}

/**
 * Build labels for the shared settings form.
 * @param t - Locale reader for this page.
 * @returns The shared form labels.
 */
export function formLabels(t: (key: ImageIterateSettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
