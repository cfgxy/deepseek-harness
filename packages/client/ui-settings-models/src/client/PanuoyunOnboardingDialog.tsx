import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelsSettingsState, ModelsSettingsStore } from './store.ts'
import { onboardingReadiness } from './store.ts'
import type { ModelsOperations } from './operations.ts'
import type { en } from './locales.ts'
import { OnboardingModal } from './OnboardingModal.tsx'
import styles from './DeepSeekOnboardingDialog.module.css'

export interface PanuoyunGroup { readonly id: string; readonly name: string }
export interface PanuoyunOnboardingOperations {
  configure(mode: 'personal' | 'enterprise', enterpriseLoginOrigin: string): Promise<void>
  login(email: string, password: string): Promise<void>
  groups(): Promise<readonly PanuoyunGroup[]>
  selectApiKey(key: string): Promise<void>
  createApiKey(name: string, groupId?: number): Promise<void>
  signOut(): Promise<void>
}

/** Registration-side dependencies of the Pa诺云 first-run step. */
export interface PanuoyunOnboardingInjected {
  automatic: boolean
  hooks: { models: SnapshotStore<ModelsSettingsState> }
  controller: ModelsSettingsStore
  operations: ModelsOperations
  panuoyun: PanuoyunOnboardingOperations
  t: (key: keyof typeof en) => string
}
export type PanuoyunOnboardingDialogProps = PropsRuntime<'settings.onboarding'> & InjectFace<PanuoyunOnboardingInjected>

type Step = 'login' | 'key'

/**
 * First-run Pa诺云 enrollment. Secret values are input-only local state: Remote
 * calls return safe projections or void, and neither password nor API key is
 * rendered after a submission.
 */
export function PanuoyunOnboardingDialog(props: PanuoyunOnboardingDialogProps): ReactNode {
  const { complete, automatic, explicit = false, controller, useModels, panuoyun, t } = props
  const [step, setStep] = useState<Step>('login')
  const [mode, setMode] = useState<'personal' | 'enterprise'>('personal')
  const [origin, setOrigin] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [groups, setGroups] = useState<readonly PanuoyunGroup[]>([])
  const [groupId, setGroupId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const state = useModels(snapshot => snapshot)
  const readiness = onboardingReadiness(state)

  useEffect(() => {
    if ((automatic || explicit) && state.status === 'idle') void controller.load()
  }, [automatic, explicit, controller, state.status])
  useEffect(() => {
    if ((!automatic && !explicit) || (!explicit && readiness.kind === 'provider-ready')) complete()
  }, [automatic, complete, explicit, readiness.kind])
  if (!automatic && !explicit) return null
  if (state.status === 'idle' || state.status === 'loading') return null
  if (!explicit && readiness.kind === 'provider-ready') return null

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try { await action() } catch { setError('操作未完成，请检查输入后重试。') } finally { setBusy(false) }
  }
  const later = (): void => { complete() }
  const exit = (): void => { void run(async () => { await panuoyun.signOut(); complete() }) }
  const login = (): void => {
    void run(async () => {
      await panuoyun.configure(mode, origin)
      await panuoyun.login(email, password)
      setPassword('')
      setGroups(await panuoyun.groups())
      setStep('key')
    })
  }
  const finish = (action: () => Promise<void>): void => {
    void run(async () => {
      await action()
      setApiKey('')
      await controller.load()
      complete()
    })
  }

  return <OnboardingModal title="派诺云账号">
    {step === 'login' ? <>
      <p className={styles.description}>登录派诺云后，选择或创建一个仅供 DeepSeek Harness 使用的密钥。</p>
      <label>版本<select value={mode} disabled={busy} onChange={(event) => { setMode(event.target.value as typeof mode) }}>
        <option value="personal">个人版</option><option value="enterprise">企业版</option>
      </select></label>
      {mode === 'enterprise' && <label>企业专属登录地址<input type="url" value={origin} disabled={busy}
        placeholder="https://tenant.ainoriahub.com" onChange={(event) => { setOrigin(event.target.value) }} /></label>}
      <label>邮箱<input type="email" autoComplete="username" value={email} disabled={busy} onChange={(event) => { setEmail(event.target.value) }} /></label>
      <label>密码<input type="password" autoComplete="current-password" value={password} disabled={busy} onChange={(event) => { setPassword(event.target.value) }} /></label>
      {error !== undefined && <p role="alert">{error}</p>}
      <div className={styles.editor}><Button variant="outline" disabled={busy} onClick={later}>{t('onboardingLater')}</Button>
        <Button variant="primary" disabled={busy || email.length === 0 || password.length === 0 || (mode === 'enterprise' && origin.length === 0)} onClick={login}>登录</Button></div>
    </> : <>
      <p className={styles.description}>不会读取或展示已有密钥。粘贴一个已有密钥，或按分组创建新的专用密钥。</p>
      <label>分组<select value={groupId} disabled={busy} onChange={(event) => { setGroupId(event.target.value) }}>
        <option value="">默认分组</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
      </select></label>
      <label>已有 API Key<input type="password" autoComplete="off" value={apiKey} disabled={busy} onChange={(event) => { setApiKey(event.target.value) }} /></label>
      {error !== undefined && <p role="alert">{error}</p>}
      <div className={styles.editor}>
        <Button variant="outline" disabled={busy} onClick={exit}>退出登录</Button>
        <Button variant="outline" disabled={busy} onClick={later}>{t('onboardingLater')}</Button>
        <Button variant="outline" disabled={busy} onClick={() => { finish(() => panuoyun.createApiKey('DeepSeek Harness', groupId === '' ? undefined : Number(groupId))) }}>新建专用 Key</Button>
        <Button variant="primary" disabled={busy || apiKey.length === 0} onClick={() => { finish(() => panuoyun.selectApiKey(apiKey)) }}>验证并继续</Button>
      </div>
    </>}
  </OnboardingModal>
}
