import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SettingsForm, SettingsSecretField, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import type { ImageIterateSettingsCardFace } from './settings-card-controller.ts'
import type { ImageIterateSettingsLocaleKey } from './locales.ts'

/** Props supplied by the Plugins page to the image settings card. */
export type ImageIterateSettingsCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.imageIterate'>
  & InjectFace<ImageIterateSettingsCardFace>

/** Render the image generation and review settings page. */
export function SettingsCard(props: ImageIterateSettingsCardProps) {
  const { t } = props
  const state = props.useImageIterateSettings(snapshot => snapshot)
  if (props.view === 'summary') return t('description')
  const disabled = !state.writable || state.saving
  const field = (name: keyof Pick<typeof state, 'imageBaseUrl' | 'imageModel' | 'imageCredential' | 'reviewBaseUrl' | 'reviewModel' | 'reviewCredential' | 'maxIterations' | 'timeoutMs' | 'defaultSize' | 'defaultQuality' | 'outputFormat'>, numeric = false, invalid: ImageIterateSettingsLocaleKey = 'invalidNumber') => (
    <SettingsValueField
      id={`plugin-config-image-iterate-${name}`}
      label={t(name)}
      overriddenLabel={t('overridden')}
      resetLabel={t('reset')}
      invalidLabel={t(invalid)}
      disabled={disabled}
      numeric={numeric}
      {...state[name]}
      onEdit={(text) => { props.edit(name, text) }}
      onReset={() => { props.resetField(name) }}
    />
  )
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      {field('imageBaseUrl')}
      {field('imageModel')}
      {field('imageCredential')}
      <SettingsSecretField
        id="plugin-config-image-iterate-image-secret"
        label={t('imageSecret')}
        hint={t('secretHint')}
        text={state.imageSecret.text}
        disabled={!state.imageWritable || state.saving}
        configured={state.imageConfigured}
        stateLabel={!state.imageCredentialKnown ? t('credentialUnknown') : state.imageConfigured ? t('configured') : t('unconfigured')}
        onEdit={(text) => { props.edit('imageSecret', text) }}
      />
      {field('reviewBaseUrl')}
      {field('reviewModel')}
      {field('reviewCredential')}
      <SettingsSecretField
        id="plugin-config-image-iterate-review-secret"
        label={t('reviewSecret')}
        hint={t('secretHint')}
        text={state.reviewSecret.text}
        disabled={!state.reviewWritable || state.saving}
        configured={state.reviewConfigured}
        stateLabel={!state.reviewCredentialKnown ? t('credentialUnknown') : state.reviewConfigured ? t('configured') : t('unconfigured')}
        onEdit={(text) => { props.edit('reviewSecret', text) }}
      />
      {field('maxIterations', true, 'invalidIterations')}
      {field('timeoutMs', true, 'invalidTimeout')}
      {field('defaultSize')}
      {field('defaultQuality')}
      {field('outputFormat', false, 'invalidFormat')}
    </SettingsForm>
  )
}
