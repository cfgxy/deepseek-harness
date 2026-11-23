/** Account authorization dialog; errors allow retry after cancelling any active attempt. */
import { useEffect, useState } from 'react'
import { Button, IconCloseOutlineRegular, IconLoadingOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountSnapshot, PanuoyunOperations } from './AccountSection.tsx'
import type { SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { AccountKey } from './locales.ts'
import { authorizeUrlWithTheme } from './authorize-url.ts'
import css from './SignInDialog.module.css'

type Route = 'panuoyun' | 'deepseek'
type PanuoyunStep = 'login' | 'key'

/** @param props - safe account state, localized copy, and user actions. @returns login dialog. */
export function SignInDialog({ account, colorScheme, start, cancel, close, useApiKey, panuoyun, t }: {
  account: AccountSnapshot
  /** Resolved scheme of the active application theme; the copied link carries it. */
  colorScheme: 'light' | 'dark'
  start: () => Promise<void>
  cancel: (id: SignInAttemptId) => Promise<void>
  close: () => void
  useApiKey: () => void
  panuoyun?: PanuoyunOperations
  t: (key: AccountKey) => string
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [copyResult, setCopyResult] = useState<{ messageKey: 'copiedLink' | 'copyFailed' } | null>(null)
  const [route, setRoute] = useState<Route>(panuoyun === undefined ? 'deepseek' : 'panuoyun')
  const [panuoyunStep, setPanuoyunStep] = useState<PanuoyunStep>('login')
  const [mode, setMode] = useState<'personal' | 'enterprise'>('personal')
  const [origin, setOrigin] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [groups, setGroups] = useState<readonly { id: string; name: string }[]>([])
  const [groupId, setGroupId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const attempt = account.view?.attempt
  useEffect(() => { setCopyResult(null) }, [attempt?.id, attempt?.authorizeUrl])
  useEffect(() => {
    if (copyResult === null) return
    const timer = setTimeout(() => { setCopyResult(null) }, 2000)
    return () => { clearTimeout(timer) }
  }, [copyResult])
  const authorizeUrl = attempt?.authorizeUrl
  const phase = attempt?.phase
  const deepseekActive = phase === 'initializing' || phase === 'waiting-browser' || phase === 'exchanging' || phase === 'committing'
  const active = busy || deepseekActive
  const expired = route === 'deepseek' && phase === 'expired'
  const localFailure = failed || (route === 'deepseek' && (account.loginFailed || account.failed))
  const error = localFailure || (route === 'deepseek' && phase === 'failed')
  const failureKey = !localFailure
    && phase === 'failed' && attempt?.errorCode === 'no-response' ? 'noResponse' : 'failed'
  const waiting = active && !error
  const committing = phase === 'committing'
  useEffect(() => { if (account.view?.status === 'credential-stored') close() }, [account.view?.status, close])
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setFailed(false)
    try { await action() } catch { setFailed(true) } finally { setBusy(false) }
  }
  const dismiss = () => {
    if (committing || busy) return
    if (active && attempt) void run(async () => { await cancel(attempt.id); close() })
    else close()
  }
  const retry = async () => {
    if (active && attempt) await cancel(attempt.id)
    await start()
  }
  const copyLink = async (authorizeUrl: string) => {
    try {
      await navigator.clipboard.writeText(authorizeUrlWithTheme(authorizeUrl, colorScheme))
      setCopyResult({ messageKey: 'copiedLink' })
    } catch { setCopyResult({ messageKey: 'copyFailed' }) }
  }
  const selectApiKey = () => { useApiKey() }
  const selectPanuoyun = () => { setRoute('panuoyun'); setFailed(false) }
  const loginPanuoyun = () => {
    if (panuoyun === undefined) return
    void run(async () => {
      await panuoyun.configure(mode, origin)
      await panuoyun.login(email, password)
      setPassword('')
      setGroups(await panuoyun.groups())
      setPanuoyunStep('key')
    })
  }
  const finishPanuoyun = (action: () => Promise<void>) => {
    if (panuoyun === undefined) return
    void run(async () => {
      await action()
      setApiKey('')
      close()
    })
  }
  const signOutPanuoyun = () => {
    if (panuoyun === undefined) return
    void run(async () => {
      await panuoyun.signOut()
      setPassword('')
      setApiKey('')
      setGroups([])
      setGroupId('')
      setPanuoyunStep('login')
    })
  }
  const title = route === 'panuoyun' && !error ? t('panuoyunTitle')
    : error ? t('failureTitle') : active ? t('browserTitle') : expired ? t('timeoutTitle') : t('loginTitle')
  const panuoyunForm = panuoyun === undefined ? null : panuoyunStep === 'login' ? <>
    <p className={css.description}>{t('panuoyunDescription')}</p>
    <div className={css.form}>
      <label>{t('panuoyunEdition')}<select value={mode} disabled={busy} onChange={(event) => { setMode(event.target.value as typeof mode) }}>
        <option value="personal">{t('panuoyunPersonal')}</option><option value="enterprise">{t('panuoyunEnterprise')}</option>
      </select></label>
      {mode === 'enterprise' && <label>{t('panuoyunEnterpriseOrigin')}<input type="url" value={origin} disabled={busy}
        placeholder="https://tenant.ainoriahub.com" onChange={(event) => { setOrigin(event.target.value) }} /></label>}
      <label>{t('panuoyunEmail')}<input type="email" autoComplete="username" value={email} disabled={busy} onChange={(event) => { setEmail(event.target.value) }} /></label>
      <label>{t('panuoyunPassword')}<input type="password" autoComplete="current-password" value={password} disabled={busy} onChange={(event) => { setPassword(event.target.value) }} /></label>
      {error && <p role="alert">{t(failureKey)}</p>}
    </div>
    <div className={css.actions}>
      <Button variant="outline" className={css.secondaryButton} disabled={busy} onClick={signOutPanuoyun}>{t('panuoyunSignOut')}</Button>
      <Button variant="outline" className={css.secondaryButton} disabled={busy} onClick={() => { setRoute('deepseek'); setFailed(false) }}>{t('deepSeekAccount')}</Button>
      <Button variant="outline" className={css.secondaryButton} disabled={busy} onClick={selectApiKey}>{t('addApiKey')}</Button>
      <Button variant="primary" className={css.primaryButton} disabled={busy || email.length === 0 || password.length === 0 || (mode === 'enterprise' && origin.length === 0)} onClick={loginPanuoyun}>{t('signIn')}</Button>
    </div>
  </> : <>
    <p className={css.description}>{t('panuoyunKeyDescription')}</p>
    <div className={css.form}>
      <label>{t('panuoyunGroup')}<select value={groupId} disabled={busy} onChange={(event) => { setGroupId(event.target.value) }}>
        <option value="">{t('panuoyunDefaultGroup')}</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
      </select></label>
      <label>{t('panuoyunApiKey')}<input type="password" autoComplete="off" value={apiKey} disabled={busy} onChange={(event) => { setApiKey(event.target.value) }} /></label>
      {error && <p role="alert">{t(failureKey)}</p>}
    </div>
    <div className={css.actions}>
      <Button variant="outline" className={css.secondaryButton} disabled={busy} onClick={signOutPanuoyun}>{t('panuoyunSignOut')}</Button>
      <Button variant="outline" className={css.secondaryButton} disabled={busy} onClick={() => { finishPanuoyun(() => panuoyun.createApiKey('DeepSeek Harness', groupId === '' ? undefined : Number(groupId))) }}>{t('panuoyunCreateKey')}</Button>
      <Button variant="primary" className={css.primaryButton} disabled={busy || apiKey.length === 0} onClick={() => { finishPanuoyun(() => panuoyun.selectApiKey(apiKey)) }}>{t('panuoyunContinue')}</Button>
    </div>
  </>
  return <Modal open headless title={title} onClose={dismiss} className={css.dialog as string}>
    <div className={css.content}>
      <div className={css.header}>
        <h2 className={css.title}>{title}</h2>
        <button type="button" className={css.close} aria-label={t('close')} onClick={dismiss}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>
      {route === 'panuoyun' && !active ? panuoyunForm : waiting ? <p className={css.description}>
        {t('browserPrompt')}<button type="button" className={css.link} disabled={!authorizeUrl}
          onClick={authorizeUrl ? () => { void copyLink(authorizeUrl) } : undefined}>
          {t(copyResult?.messageKey ?? 'copyLink')}
        </button>{t('browserDescription')}
      </p> : <p className={css.description}>
        {error ? t(failureKey) : expired ? t('timeoutDescription') : t('loginDescription')}
      </p>}
    </div>
    {(route !== 'panuoyun' || active) && <div className={css.actions}>
      <Button variant="outline" className={css.secondaryButton} disabled={committing || busy}
        onClick={active ? dismiss : selectApiKey}>{t(active ? 'cancel' : 'addApiKey')}</Button>
      {route === 'deepseek' && !active && panuoyun !== undefined && <Button variant="outline" className={css.secondaryButton}
        onClick={selectPanuoyun}>{t('panuoyunTitle')}</Button>}
      <Button variant="primary" className={css.primaryButton} disabled={busy || committing || waiting || account.view === undefined}
        aria-label={waiting ? t('waiting') : undefined} onClick={() => { void run(retry) }}>
        {waiting ? <IconLoadingOutlineRegular className={css.spinner} /> : t(expired || error ? 'retry' : 'signIn')}
      </Button>
    </div>}
  </Modal>
}
