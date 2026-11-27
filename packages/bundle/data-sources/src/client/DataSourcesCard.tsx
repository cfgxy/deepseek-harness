/* oxlint-disable @stylistic/max-len -- dense JSX keeps each field's allowlisted write adjacent to its control. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Modal, StateDot, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { type DataSourceDraft, type DataSourcesCardFace, type DataSourcesCardState, type DraftKind, type SourceKind, validateDraft } from './settings-controller.ts'
import styles from './DataSourcesCard.module.css'

export type DataSourcesCardProps = PropsRuntime<'plugins.item'> & PropsLocale<'settings.dataSources'> & InjectFace<DataSourcesCardFace>

const databaseKinds: readonly SourceKind[] = ['mysql', 'postgresql']
const directoryKinds: readonly SourceKind[] = ['local-directory', 'smb', 'nfs', 'sftp', 'ftp', 'webdav']
const noAuthKinds: readonly SourceKind[] = ['local-directory', 'smb', 'nfs']

function copy(source: DataSourceDraft): DataSourceDraft { return structuredClone(source) }
function detailKind(kind: DraftKind): string { return kind === '' ? '' : kind }
function probeState(phase: 'idle' | 'pending' | 'success' | 'error'): 'idle' | 'ongoing' | 'done' | 'error' {
  const states = { idle: 'idle', pending: 'ongoing', success: 'done', error: 'error' } as const
  return states[phase]
}

type RememberedDraft = {
  readonly controllerId: number
  /** Host revision at the beginning of the edit, not the revision last observed. */
  readonly scopeRevision: number
  readonly selectedId: string | undefined
  readonly draft: DataSourceDraft
  readonly baseline: DataSourceDraft
  readonly advanced: boolean
}

/** Deliberately process-local: a dirty draft survives a same-session page remount, never storage. */
let rememberedDraft: RememberedDraft | undefined

function canRestore(remembered: RememberedDraft | undefined, state: DataSourcesCardState): remembered is RememberedDraft {
  return remembered !== undefined && remembered.controllerId === state.controllerId
    && (remembered.selectedId === undefined || state.sources.some(source => source.id === remembered.selectedId))
}

type PendingAction =
  | { readonly type: 'open'; readonly source: DataSourceDraft }
  | { readonly type: 'add' }
  | { readonly type: 'kind'; readonly kind: DraftKind }
  | { readonly type: 'remove' }

function credentialSample(kind: DraftKind): string {
  switch (kind) {
    case 'mysql':
      return 'MY_MYSQL_AUTH: \'{"username":"root","password":"your_password"}\''
    case 'postgresql':
      return 'MY_PG_AUTH: \'{"username":"postgres","password":"your_password"}\''
    case 's3':
      return 'MY_S3_AUTH: \'{"accessKeyId":"AKIA...","secretAccessKey":"..."}\''
    case 'sftp':
      return 'MY_SFTP_AUTH: \'{"username":"user","privateKey":"-----BEGIN..."}\''
    case 'ftp':
      return 'MY_FTP_AUTH: \'{"username":"ftpuser","password":"..."}\''
    case 'webdav':
      return 'MY_WEBDAV_AUTH: \'{"username":"user","password":"..."}\''
    default:
      return 'MY_DB_AUTH: \'{"username":"...","password":"..."}\''
  }
}

/** Render one configured source without ever placing a credential value in the DOM. */
export function DataSourcesCard(props: DataSourcesCardProps) {
  const state = props.useDataSourcesSettings(snapshot => snapshot)
  const restored = canRestore(rememberedDraft, state) ? rememberedDraft : undefined
  const [selectedId, setSelectedId] = useState<string | undefined>(() => restored?.selectedId)
  const selected = state.sources.find(source => source.id === selectedId)
  const [draft, setDraft] = useState<DataSourceDraft | undefined>(() => restored === undefined ? undefined : copy(restored.draft))
  const [baseline, setBaseline] = useState<DataSourceDraft | undefined>(() => restored === undefined ? undefined : copy(restored.baseline))
  const [baselineScopeRevision, setBaselineScopeRevision] = useState(() => restored?.scopeRevision ?? state.scopeRevision)
  const [error, setError] = useState<string | undefined>(() => restored !== undefined && restored.scopeRevision !== state.scopeRevision ? props.t('saveConflict') : undefined)
  const [notice, setNotice] = useState<string | undefined>()
  const [confirm, setConfirm] = useState<'discard' | 'remove' | undefined>()
  const [pendingAction, setPendingAction] = useState<PendingAction | undefined>()
  const [advanced, setAdvanced] = useState(() => restored?.advanced ?? false)
  const restoredSelection = useRef(restored !== undefined)
  const previousSelectedId = useRef<string | undefined>(selectedId)
  const preserveNoticeForId = useRef<string | undefined>()

  const dirty = draft !== undefined && baseline !== undefined && JSON.stringify(draft) !== JSON.stringify(baseline)
  const baselineChanged = draft !== undefined && baselineScopeRevision !== state.scopeRevision

  useEffect(() => {
    if (selected === undefined) return
    if (restoredSelection.current) { restoredSelection.current = false; return }
    const switched = previousSelectedId.current !== selected.id
    const preserveNotice = preserveNoticeForId.current === selected.id
    if (!switched && dirty) {
      if (baselineChanged) setError(props.t('saveConflict'))
      return
    }
    if (preserveNotice) preserveNoticeForId.current = undefined
    previousSelectedId.current = selected.id
    const next = copy(selected)
    setDraft(next)
    setBaseline(copy(next))
    setBaselineScopeRevision(state.scopeRevision)
    setError(undefined)
    if (switched && !preserveNotice) setNotice(undefined)
    setAdvanced(false)
  }, [baselineChanged, dirty, props.t, selected?.id, selected?.revision, state.scopeRevision])

  useEffect(() => {
    if (!dirty) { rememberedDraft = undefined; return }
    rememberedDraft = { controllerId: state.controllerId, scopeRevision: baselineScopeRevision, selectedId, draft: copy(draft), baseline: copy(baseline), advanced }
  }, [advanced, baseline, baselineScopeRevision, dirty, draft, selectedId, state.controllerId])
  const isNew = draft !== undefined && !state.sources.some(source => source.id === draft.id)
  const disabled = !state.available || !state.writable || state.saving
  const validation = draft === undefined ? undefined : validateDraft(draft)
  const currentProbe = draft === undefined || dirty || isNew ? undefined : state.probes[draft.id]

  const replaceKind = (source: DataSourceDraft, kind: DraftKind): DataSourceDraft => ({
    ...source,
    kind,
    credentialRef: '',
    connection: { ...source.connection, endpoint: '', bucket: '', region: '', host: '', port: kind === '' ? '' : defaultPort(kind), database: '', knownHostsPath: '', timeoutMs: '10000', statementTimeoutMs: '', tlsEnabled: false, tlsCaPath: '', tlsServerName: '' },
    policy: { ...source.policy, allowedPath: '', allowedPrefix: '' },
  })
  const execute = (action: PendingAction): void => {
    if (action.type === 'open') { setSelectedId(action.source.id); return }
    if (action.type === 'add') {
      const next = props.create()
      setSelectedId(undefined)
      setDraft(next)
      setBaseline(copy(next))
      setBaselineScopeRevision(state.scopeRevision)
      setError(undefined)
      setNotice(undefined)
      setAdvanced(false)
      return
    }
    if (action.type === 'remove') { setConfirm('remove'); return }
    if (draft !== undefined) setDraft(replaceKind(draft, action.kind))
  }
  const request = (action: PendingAction): void => {
    if (dirty) { setPendingAction(action); setConfirm('discard'); return }
    execute(action)
  }
  const open = (source: DataSourceDraft): void => {
    if (source.id !== selectedId) request({ type: 'open', source })
  }
  const add = (): void => { request({ type: 'add' }) }
  const update = (recipe: (source: DataSourceDraft) => DataSourceDraft): void => {
    if (draft === undefined) return
    setDraft(recipe(draft))
    setError(baselineChanged ? props.t('saveConflict') : undefined)
    setNotice(undefined)
  }
  const changeKind = (kind: DraftKind): void => {
    if (draft !== undefined && kind !== draft.kind) request({ type: 'kind', kind })
  }
  const close = (): void => {
    if (dirty) { setPendingAction(undefined); setConfirm('discard'); return }
    setSelectedId(undefined); setDraft(undefined); setBaseline(undefined); setError(undefined); setNotice(undefined)
  }
  const save = (overrideDraft?: DataSourceDraft): void => {
    const target = overrideDraft ?? draft
    if (target === undefined) return
    const targetValidation = validateDraft(target)
    if (targetValidation !== undefined) {
      setError(targetValidation)
      return
    }
    void props.save(target, baselineScopeRevision).then((result) => {
      if (result === 'conflict') { setError(props.t('saveConflict')); return }
      if (result !== 'saved') { setError(props.t('saveFailed')); return }
      setDraft(copy(target))
      setBaseline(copy(target))
      setBaselineScopeRevision(state.scopeRevision)
      preserveNoticeForId.current = target.id
      setSelectedId(target.id)
      setNotice(props.t('saved'))
    })
  }
  const requestRemove = (): void => {
    if (draft === undefined || isNew) return
    if (dirty) { setPendingAction({ type: 'remove' }); setConfirm('discard'); return }
    setConfirm('remove')
  }
  const remove = (): void => {
    if (draft === undefined || isNew) return
    void props.remove(draft.id).then((accepted) => {
      if (!accepted) { setError(props.t('saveFailed')); return }
      setConfirm(undefined); setSelectedId(undefined); setDraft(undefined); setBaseline(undefined); setNotice(undefined)
    })
  }

  if (props.view === 'summary') return state.sources.length === 0 ? props.t('emptySummary') : props.t('summary')

  const input = (
    name: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: { type?: 'text' | 'number' | 'password'; hint?: string } = {},
  ) => (
    <label className={styles.field} htmlFor={`plugin-config-data-sources-${name}`}>
      <span>{label}</span>
      <input
        id={`plugin-config-data-sources-${name}`}
        type={options.type ?? 'text'}
        value={value}
        disabled={disabled}
        aria-invalid={error !== undefined || validation !== undefined ? true : undefined}
        onChange={event => onChange(event.currentTarget.value)}
      />
      {options.hint === undefined ? null : <small>{options.hint}</small>}
    </label>
  )
  const connection = draft === undefined ? null : <>
    {draft.kind === 's3' || draft.kind === 'webdav'
      ? input('endpoint', props.t('endpoint'), draft.connection.endpoint, value => (
        update(source => ({ ...source, connection: { ...source.connection, endpoint: value } }))
      )) : null}
    {draft.kind === 's3' ? <>
      {input('bucket', props.t('bucket'), draft.connection.bucket, value => (
        update(source => ({ ...source, connection: { ...source.connection, bucket: value } }))
      ))}
      {input('region', props.t('region'), draft.connection.region, value => (
        update(source => ({ ...source, connection: { ...source.connection, region: value } }))
      ))}
    </> : null}
    {['sftp', 'ftp', 'mysql', 'postgresql'].includes(draft.kind)
      ? input('host', props.t('host'), draft.connection.host, value => (
        update(source => ({ ...source, connection: { ...source.connection, host: value } }))
      )) : null}
    {['sftp', 'ftp', 'mysql', 'postgresql'].includes(draft.kind)
      ? input('port', props.t('port'), draft.connection.port, value => (
        update(source => ({ ...source, connection: { ...source.connection, port: value } }))
      ), { type: 'number' }) : null}
    {databaseKinds.includes(draft.kind as SourceKind)
      ? input('database', props.t('database'), draft.connection.database, value => (
        update(source => ({ ...source, connection: { ...source.connection, database: value } }))
      )) : null}
    {draft.kind === 'sftp'
      ? input('known-hosts', props.t('knownHostsPath'), draft.connection.knownHostsPath, value => (
        update(source => ({ ...source, connection: { ...source.connection, knownHostsPath: value } }))
      )) : null}
  </>

  return <section className={styles.section} aria-label={props.t('title')} aria-busy={!state.available || state.saving}>
    <header className={styles.header}>
      <div><h2>{props.t('title')}</h2><p>{props.t('description')}</p></div>
      {state.sources.length === 0 ? null : <Button variant="primary" disabled={disabled} onClick={add}>{props.t('add')}</Button>}
    </header>
    {!state.available ? <p className={styles.error} role="alert">{props.t('loadFailed')}</p> : null}
    {!state.writable && state.available ? <p className={styles.notice}>{props.t('readOnly')}</p> : null}
    {state.envStatus && !state.envStatus.mcpRunning ? (
      <div className={styles.envBanner} role="region" aria-label={props.t('envBannerTitle')}>
        <div className={styles.envBannerHead}>
          <div className={styles.envBannerTitle}>
            <Tag tone={state.envStatus.hasUv ? 'neutral' : 'warning'}>
              {state.envStatus.hasUv ? props.t('envUvFound') : props.t('envMissingTag')}
            </Tag>
            <strong>{props.t('envBannerTitle')}</strong>
          </div>
          <div className={styles.envBannerActions}>
            <Button
              variant="primary"
              disabled={state.envStatus.installing}
              onClick={() => { props.installEnvironment() }}
            >
              {state.envStatus.installing ? props.t('installingEnv') : props.t('installEnv')}
            </Button>
            <Button
              variant="outline"
              disabled={state.envStatus.reloading || state.envStatus.installing}
              onClick={() => { props.reloadMcp() }}
            >
              {state.envStatus.reloading ? props.t('reloadingMcp') : props.t('reloadMcp')}
            </Button>
          </div>
        </div>
        <p className={styles.hint}>{props.t('envBannerDesc')}</p>
        {state.envStatus.message ? (
          <p className={styles.success}><StateDot state="done" />{state.envStatus.message}</p>
        ) : null}
        {state.envStatus.error ? (
          <p className={styles.error} role="alert">{state.envStatus.error}</p>
        ) : null}
      </div>
    ) : null}
    {state.envStatus && state.envStatus.mcpRunning && state.envStatus.message ? (
      <div className={styles.envBanner} role="region" aria-label={props.t('envBannerTitle')}>
        <p className={styles.success}><StateDot state="done" />{state.envStatus.message}</p>
      </div>
    ) : null}
    {state.sources.length === 0 && draft === undefined && state.available ? <div className={styles.empty}><p>{props.t('empty')}</p><Button variant="primary" disabled={disabled} onClick={add}>{props.t('add')}</Button></div> : null}
    <div role="list" className={styles.list} aria-label={props.t('sources')}>
      {state.sources.map((source) => {
        const expanded = draft !== undefined && !isNew && source.id === selectedId
        const probe = state.probes[source.id]
        return <article className={styles.card} role="listitem" key={source.id}>
          <div className={styles.cardHead}>
            <button className={styles.disclosure} type="button" aria-expanded={expanded} aria-controls={`data-source-editor-${source.id}`} onClick={() => expanded ? close() : open(source)}>
              <span className={styles.icon} aria-hidden="true">{source.kind.slice(0, 1).toUpperCase()}</span>
              <span className={styles.identity}><strong>{source.label || source.id}</strong><small>{detailKind(source.kind)}</small></span>
            </button>
            <Tag tone={source.enabled ? 'success' : 'neutral'}>{source.enabled ? props.t('enabled') : props.t('disabled')}</Tag>
            <Switch checked={source.enabled} label={`${source.label || source.id}: ${props.t('enabled')}`} disabled={disabled || (expanded && dirty)} title={expanded && dirty ? props.t('testDisabledDirty') : undefined} onChange={(enabled) => { void props.setEnabled(source.id, enabled) }} />
          </div>
          {!expanded && probe?.phase === 'success' ? <p className={styles.probe}><StateDot state="done" />{props.t('testSuccess')}</p> : null}
          {expanded ? (
            <Editor
              id={`data-source-editor-${source.id}`}
              isNew={false}
              draft={draft}
              disabled={disabled}
              dirty={dirty}
              error={error}
              notice={notice}
              validation={validation}
              currentProbe={currentProbe}
              advanced={advanced}
              credentials={state.credentials}
              input={input}
              connection={connection}
              update={update}
              changeKind={changeKind}
              setAdvanced={setAdvanced}
              save={save}
              close={close}
              requestRemove={requestRemove}
              props={props}
            />
          ) : null}
        </article>
      })}
      {draft !== undefined && isNew ? (
        <article className={styles.card} role="listitem">
          <Editor
            id="data-source-editor-new"
            isNew
            draft={draft}
            disabled={disabled}
            dirty={dirty}
            error={error}
            notice={notice}
            validation={validation}
            currentProbe={currentProbe}
            advanced={advanced}
            credentials={state.credentials}
            input={input}
            connection={connection}
            update={update}
            changeKind={changeKind}
            setAdvanced={setAdvanced}
            save={save}
            close={close}
            requestRemove={requestRemove}
            props={props}
          />
        </article>
      ) : null}
    </div>
    <Modal open={confirm === 'discard'} title={props.t('discardTitle')} description={props.t('discardDescription')} closeLabel={props.t('close')} onClose={() => { setConfirm(undefined); setPendingAction(undefined) }} footer={<><Button data-modal-autofocus variant="outline" onClick={() => { setConfirm(undefined); setPendingAction(undefined) }}>{props.t('continueEditing')}</Button><Button variant="primary" onClick={() => { const action = pendingAction; setConfirm(undefined); setPendingAction(undefined); if (action !== undefined) execute(action); else { setSelectedId(undefined); setDraft(undefined); setBaseline(undefined); setError(undefined); setNotice(undefined) } }}>{props.t('discardChanges')}</Button></>} />
    <Modal open={confirm === 'remove'} title={props.t('removeTitle')} description={props.t('removeDescription')} closeLabel={props.t('close')} onClose={() => setConfirm(undefined)} footer={<><Button data-modal-autofocus variant="outline" onClick={() => setConfirm(undefined)}>{props.t('cancel')}</Button><Button variant="primary" onClick={remove}>{props.t('confirmRemove')}</Button></>} />
  </section>
}

function defaultPort(kind: DraftKind): string {
  if (kind === 'sftp') return '22'
  if (kind === 'ftp') return '21'
  if (kind === 'mysql') return '3306'
  if (kind === 'postgresql') return '5432'
  return ''
}

type EditorProps = {
  id: string
  isNew: boolean
  draft: DataSourceDraft
  disabled: boolean
  dirty: boolean
  error?: string | undefined
  notice?: string | undefined
  validation?: string | undefined
  currentProbe?: { phase: 'idle' | 'pending' | 'success' | 'error'; message?: string | undefined } | undefined
  advanced: boolean
  credentials: readonly { ref: string; configured: boolean; source?: string; writable: boolean }[]
  input: (
    name: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    options?: { type?: 'text' | 'number' | 'password'; hint?: string },
  ) => ReactElement
  connection: ReactElement | null
  update: (recipe: (source: DataSourceDraft) => DataSourceDraft) => void
  changeKind: (kind: DraftKind) => void
  setAdvanced: (value: boolean) => void
  save: (overrideDraft?: DataSourceDraft) => void
  close: () => void
  requestRemove: () => void
  props: DataSourcesCardProps
}

function Editor({
  id,
  isNew,
  draft,
  disabled,
  dirty,
  error,
  notice,
  validation,
  currentProbe,
  advanced,
  credentials,
  input,
  connection,
  update,
  changeKind,
  setAdvanced,
  save,
  close,
  requestRemove,
  props,
}: EditorProps) {
  const database = databaseKinds.includes(draft.kind as SourceKind)
  const directory = directoryKinds.includes(draft.kind as SourceKind)
  const testDisabled = disabled || dirty || !draft.enabled || draft.kind === ''
  const testTitle = dirty ? props.t('testDisabledDirty') : !draft.enabled ? props.t('testDisabledSource') : undefined
  const typeHint = useMemo(() => (
    draft.kind === 'ftp' ? props.t('ftpWarning')
      : draft.kind === 'smb' || draft.kind === 'nfs' ? props.t('mountedHint')
        : database ? props.t('databaseHint')
          : undefined
  ), [database, draft.kind, props])

  const [authMode, setAuthMode] = useState<'direct' | 'reference'>(() => {
    if (draft.credentialRef && !draft.credentialRef.startsWith('DS_')) return 'reference'
    return 'direct'
  })
  const [directUsername, setDirectUsername] = useState('')
  const [directPassword, setDirectPassword] = useState('')
  const [directAccessKeyId, setDirectAccessKeyId] = useState('')
  const [directSecretAccessKey, setDirectSecretAccessKey] = useState('')
  const [directPrivateKey, setDirectPrivateKey] = useState('')
  const [isCustomRef, setIsCustomRef] = useState(() => (
    Boolean(draft.credentialRef && !credentials.some(c => c.ref === draft.credentialRef))
  ))

  useEffect(() => {
    if (draft.credentialRef && credentials.some(c => c.ref === draft.credentialRef)) {
      setIsCustomRef(false)
    }
  }, [credentials, draft.credentialRef])
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newCredRef, setNewCredRef] = useState('')
  const [newCredValue, setNewCredValue] = useState('')
  const [newCredError, setNewCredError] = useState<string | undefined>()
  const [newCredSaving, setNewCredSaving] = useState(false)
  const [confirmDeleteModal, setConfirmDeleteModal] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [internalError, setInternalError] = useState<string | undefined>()

  const handleCreateCredential = async () => {
    const ref = newCredRef.trim()
    if (!ref) return
    setNewCredSaving(true)
    setNewCredError(undefined)
    try {
      const res = await props.saveCredential(ref, newCredValue)
      if (!res.ok) {
        setNewCredError(res.message || '保存凭据失败')
        return
      }
      await props.refreshCredentials()
      update(source => ({ ...source, credentialRef: ref }))
      setIsCustomRef(false)
      setShowCreateModal(false)
      setNewCredRef('')
      setNewCredValue('')
    } catch (err) {
      setNewCredError(err instanceof Error ? err.message : String(err))
    } finally {
      setNewCredSaving(false)
    }
  }

  const handleDeleteCredential = async () => {
    if (!draft.credentialRef) return
    try {
      const res = await props.deleteCredential(draft.credentialRef)
      if (!res.ok) return
      await props.refreshCredentials()
      update(source => ({ ...source, credentialRef: '' }))
      setConfirmDeleteModal(false)
    } catch {}
  }

  const handleFormSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (disabled || submitting) return
    setSubmitting(true)
    setInternalError(undefined)
    try {
      let targetDraft = draft
      if (!noAuthKinds.includes(draft.kind as SourceKind) && authMode === 'direct') {
        const hasDirectValues = (draft.kind === 's3' && (directAccessKeyId || directSecretAccessKey))
          || (draft.kind === 'sftp' && (directUsername || directPassword || directPrivateKey))
          || (['mysql', 'postgresql', 'ftp', 'webdav'].includes(draft.kind) && (directUsername || directPassword))
        if (hasDirectValues) {
          const refName = draft.credentialRef && !draft.credentialRef.startsWith('DS_')
            ? draft.credentialRef
            : `DS_${draft.id.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_AUTH`
          let payload = ''
          if (draft.kind === 's3') {
            payload = JSON.stringify({ accessKeyId: directAccessKeyId, secretAccessKey: directSecretAccessKey })
          } else if (draft.kind === 'sftp') {
            payload = directPrivateKey
              ? JSON.stringify({ username: directUsername, privateKey: directPrivateKey })
              : JSON.stringify({ username: directUsername, password: directPassword })
          } else {
            payload = JSON.stringify({ username: directUsername, password: directPassword })
          }
          const res = await props.saveCredential(refName, payload)
          if (!res.ok) {
            setInternalError(res.message || '保存凭据失败')
            return
          }
          targetDraft = { ...draft, credentialRef: refName }
          update(() => targetDraft)
          await props.refreshCredentials()
        }
      }
      save(targetDraft)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form id={id} className={styles.editor} onSubmit={handleFormSubmit}>
      <div className={styles.editorTop}>
        <h3>{props.t('edit')}</h3>
        {dirty ? <Tag tone="neutral">{props.t('unsaved')}</Tag> : null}
      </div>
      <fieldset>
        <legend>{props.t('edit')}</legend>
        {input('label', props.t('label'), draft.label, value => update(source => ({ ...source, label: value })))}
        <label className={styles.field} htmlFor="plugin-config-data-sources-kind">
          <span>{props.t('sourceType')}</span>
          <select
            id="plugin-config-data-sources-kind"
            value={draft.kind}
            disabled={disabled || !isNew}
            onChange={event => changeKind(event.currentTarget.value as DraftKind)}
          >
            <option value="">{props.t('selectType')}</option>
            <optgroup label={props.t('localGroup')}>
              <option value="local-directory">local-directory</option>
              <option value="smb">smb</option>
              <option value="nfs">nfs</option>
            </optgroup>
            <optgroup label={props.t('objectGroup')}>
              <option value="s3">s3</option>
            </optgroup>
            <optgroup label={props.t('remoteGroup')}>
              <option value="sftp">sftp</option>
              <option value="ftp">ftp</option>
              <option value="webdav">webdav</option>
            </optgroup>
            <optgroup label={props.t('databaseGroup')}>
              <option value="mysql">mysql</option>
              <option value="postgresql">postgresql</option>
            </optgroup>
          </select>
        </label>
        {typeHint === undefined ? null : <p className={styles.hint}>{typeHint}</p>}
      </fieldset>
      {draft.kind === '' ? <p className={styles.hint}>{props.t('typeRequired')}</p> : <>
        {connection === null ? null : (
          <fieldset>
            <legend>{props.t('connection')}</legend>
            <div className={styles.grid}>{connection}</div>
          </fieldset>
        )}
        {noAuthKinds.includes(draft.kind as SourceKind) ? null : (
          <fieldset>
            <legend>{props.t('authMode')}</legend>
            <div className={styles.authModeToggle}>
              <button
                type="button"
                className={`${styles.authModeBtn} ${authMode === 'direct' ? styles.authModeBtnActive : ''}`}
                onClick={() => setAuthMode('direct')}
              >
                {props.t('authModeDirect')}
              </button>
              <button
                type="button"
                className={`${styles.authModeBtn} ${authMode === 'reference' ? styles.authModeBtnActive : ''}`}
                onClick={() => setAuthMode('reference')}
              >
                {props.t('authModeReference')}
              </button>
            </div>
            {authMode === 'direct' ? (
              <div className={styles.grid}>
                {draft.kind === 's3' ? <>
                  <label className={styles.field} htmlFor="ds-direct-s3-ak">
                    <span>{props.t('accessKeyId')}</span>
                    <input
                      id="ds-direct-s3-ak"
                      type="text"
                      value={directAccessKeyId}
                      disabled={disabled}
                      placeholder={draft.credentialRef ? '已配置 (留空表示不修改)' : '例如 AKIA...'}
                      onChange={e => setDirectAccessKeyId(e.currentTarget.value)}
                    />
                  </label>
                  <label className={styles.field} htmlFor="ds-direct-s3-sk">
                    <span>{props.t('secretAccessKey')}</span>
                    <input
                      id="ds-direct-s3-sk"
                      type="password"
                      value={directSecretAccessKey}
                      disabled={disabled}
                      placeholder={draft.credentialRef ? '••••••••' : ''}
                      onChange={e => setDirectSecretAccessKey(e.currentTarget.value)}
                    />
                  </label>
                </> : draft.kind === 'sftp' ? <>
                  <label className={styles.field} htmlFor="ds-direct-sftp-user">
                    <span>{props.t('username')}</span>
                    <input
                      id="ds-direct-sftp-user"
                      type="text"
                      value={directUsername}
                      disabled={disabled}
                      onChange={e => setDirectUsername(e.currentTarget.value)}
                    />
                  </label>
                  <label className={styles.field} htmlFor="ds-direct-sftp-pass">
                    <span>{props.t('password')}</span>
                    <input
                      id="ds-direct-sftp-pass"
                      type="password"
                      value={directPassword}
                      disabled={disabled}
                      placeholder={draft.credentialRef ? '••••••••' : ''}
                      onChange={e => setDirectPassword(e.currentTarget.value)}
                    />
                  </label>
                  <label className={styles.field} htmlFor="ds-direct-sftp-pk">
                    <span>{props.t('privateKey')}</span>
                    <textarea
                      id="ds-direct-sftp-pk"
                      className={styles.credModalTextarea}
                      rows={3}
                      value={directPrivateKey}
                      disabled={disabled}
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                      onChange={e => setDirectPrivateKey(e.currentTarget.value)}
                    />
                  </label>
                </> : <>
                  <label className={styles.field} htmlFor="ds-direct-user">
                    <span>{props.t('username')}</span>
                    <input
                      id="ds-direct-user"
                      type="text"
                      value={directUsername}
                      disabled={disabled}
                      onChange={e => setDirectUsername(e.currentTarget.value)}
                    />
                  </label>
                  <label className={styles.field} htmlFor="ds-direct-pass">
                    <span>{props.t('password')}</span>
                    <input
                      id="ds-direct-pass"
                      type="password"
                      value={directPassword}
                      disabled={disabled}
                      placeholder={draft.credentialRef ? '••••••••' : ''}
                      onChange={e => setDirectPassword(e.currentTarget.value)}
                    />
                  </label>
                </>}
                <small className={styles.hint}>{props.t('credentialHint')}</small>
              </div>
            ) : (
              <div className={styles.grid}>
                <label className={styles.field} htmlFor="ds-cred-select">
                  <span>{props.t('selectCredential')}</span>
                  <div className={styles.credSelectRow}>
                    <select
                      id="ds-cred-select"
                      value={isCustomRef ? '__custom__' : (draft.credentialRef || '')}
                      disabled={disabled}
                      onChange={(e) => {
                        const val = e.currentTarget.value
                        if (val === '__custom__') {
                          setIsCustomRef(true)
                        } else {
                          setIsCustomRef(false)
                          update(source => ({ ...source, credentialRef: val }))
                        }
                      }}
                    >
                      <option value="">{props.t('selectCredentialPlaceholder')}</option>
                      {credentials.map(c => (
                        <option key={c.ref} value={c.ref}>
                          {c.ref} {c.configured ? '(已配置)' : '(未配置)'}
                        </option>
                      ))}
                      <option value="__custom__">{props.t('customCredentialOption')}</option>
                    </select>
                    <Button
                      type="button"
                      variant="outline"
                      className={styles.credActionBtn}
                      onClick={() => {
                        setNewCredRef('')
                        setNewCredValue(credentialSample(draft.kind))
                        setShowCreateModal(true)
                      }}
                    >
                      {props.t('createCredentialBtn')}
                    </Button>
                    {draft.credentialRef && credentials.some(c => c.ref === draft.credentialRef && c.writable) ? (
                      <Button
                        type="button"
                        variant="outline"
                        className={styles.credActionBtn}
                        onClick={() => setConfirmDeleteModal(true)}
                      >
                        {props.t('deleteCredentialBtn')}
                      </Button>
                    ) : null}
                  </div>
                </label>
                {isCustomRef ? (
                  input(
                    'credential-reference',
                    props.t('credentialRef'),
                    draft.credentialRef,
                    value => update(source => ({ ...source, credentialRef: value })),
                    { hint: props.t('credentialHint') },
                  )
                ) : null}
                <details className={styles.credentialGuide}>
                  <summary>{props.t('credentialGuideTitle')}</summary>
                  <div className={styles.credentialGuideContent}>
                    <p>{props.t('credentialGuideDesc')}</p>
                    <pre className={styles.credentialCode}>
                      <code>{`# ~/.dsh/.credentials.yaml\nversion: 1\nrefs:\n  ${credentialSample(draft.kind)}`}</code>
                    </pre>
                  </div>
                </details>
              </div>
            )}
          </fieldset>
        )}
        <fieldset>
          <legend>{props.t('policy')}</legend>
          <div className={styles.grid}>
            {directory ? input('allowed-path', props.t('allowedPath'), draft.policy.allowedPath, value => (
              update(source => ({ ...source, policy: { ...source.policy, allowedPath: value } }))
            )) : null}
            {draft.kind === 's3' ? input('allowed-prefix', props.t('allowedPrefix'), draft.policy.allowedPrefix, value => (
              update(source => ({ ...source, policy: { ...source.policy, allowedPrefix: value } }))
            )) : null}
            {input('max-bytes', props.t('maxBytes'), draft.policy.maxBytes, value => (
              update(source => ({ ...source, policy: { ...source.policy, maxBytes: value } }))
            ), { type: 'number' })}
            {input('max-rows', props.t('maxRows'), draft.policy.maxRows, value => (
              update(source => ({ ...source, policy: { ...source.policy, maxRows: value } }))
            ), { type: 'number' })}
          </div>
        </fieldset>
        <details className={styles.advanced} open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}>
          <summary>{props.t('advanced')}</summary>
          <div className={styles.grid}>
            {input('timeout', props.t('timeoutMs'), draft.connection.timeoutMs, value => (
              update(source => ({ ...source, connection: { ...source.connection, timeoutMs: value } }))
            ), { type: 'number' })}
            {database ? <>
              {input('statement-timeout', props.t('statementTimeoutMs'), draft.connection.statementTimeoutMs, value => (
                update(source => ({ ...source, connection: { ...source.connection, statementTimeoutMs: value } }))
              ), { type: 'number' })}
              <label className={styles.toggle}>
                <span>{props.t('tlsEnabled')}</span>
                <Switch
                  checked={draft.connection.tlsEnabled}
                  label={props.t('tlsEnabled')}
                  disabled={disabled}
                  onChange={value => update(source => ({ ...source, connection: { ...source.connection, tlsEnabled: value } }))}
                />
              </label>
              {draft.connection.tlsEnabled ? <>
                {input('tls-ca-path', props.t('tlsCaPath'), draft.connection.tlsCaPath, value => (
                  update(source => ({ ...source, connection: { ...source.connection, tlsCaPath: value } }))
                ))}
                {input('tls-server-name', props.t('tlsServerName'), draft.connection.tlsServerName, value => (
                  update(source => ({ ...source, connection: { ...source.connection, tlsServerName: value } }))
                ))}
              </> : null}
            </> : null}
          </div>
        </details>
      </>}
      {error === undefined && validation === undefined && internalError === undefined ? null : (
        <p role="alert" className={styles.error}>{internalError ?? error ?? props.t('validationFailed')}</p>
      )}
      {notice === undefined ? null : <p role="status" className={styles.success}><StateDot state="done" />{notice}</p>}
      {currentProbe === undefined ? null : (
        <p role="status" className={styles.probe}>
          <StateDot state={probeState(currentProbe.phase)} />{currentProbe.message}
        </p>
      )}
      <div className={styles.actions}>
        <Button variant="outline" disabled={disabled} onClick={close}>{props.t('cancel')}</Button>
        <Button variant="outline" disabled={testDisabled} title={testTitle} onClick={() => props.test(draft.id)}>
          {currentProbe?.phase === 'pending' ? props.t('testing') : props.t('test')}
        </Button>
        <Button variant="primary" disabled={disabled || validation !== undefined || submitting} type="submit">
          {disabled || submitting ? props.t('saving') : props.t('save')}
        </Button>
      </div>
      {!isNew ? <Button className={styles.remove} disabled={disabled} onClick={requestRemove}>{props.t('remove')}</Button> : null}
      <Modal
        open={showCreateModal}
        title={props.t('createCredentialTitle')}
        description={props.t('credentialGuideDesc')}
        closeLabel={props.t('close')}
        onClose={() => { setShowCreateModal(false); setNewCredError(undefined) }}
        footer={
          <>
            <Button variant="outline" onClick={() => { setShowCreateModal(false); setNewCredError(undefined) }}>
              {props.t('cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={newCredSaving || !newCredRef.trim()}
              onClick={handleCreateCredential}
            >
              {props.t('confirmCreate')}
            </Button>
          </>
        }
      >
        <div className={styles.credModalForm}>
          <label className={styles.field} htmlFor="new-cred-ref">
            <span>{props.t('credentialNameLabel')}</span>
            <input
              id="new-cred-ref"
              type="text"
              placeholder="例如 MY_PROD_DB"
              value={newCredRef}
              onChange={e => setNewCredRef(e.currentTarget.value)}
            />
          </label>
          <label className={styles.field} htmlFor="new-cred-val">
            <span>{props.t('credentialValueLabel')}</span>
            <textarea
              id="new-cred-val"
              className={styles.credModalTextarea}
              rows={4}
              value={newCredValue}
              onChange={e => setNewCredValue(e.currentTarget.value)}
            />
          </label>
          {newCredError ? <p className={styles.error} role="alert">{newCredError}</p> : null}
        </div>
      </Modal>
      <Modal
        open={confirmDeleteModal}
        title={props.t('confirmDeleteCredential')}
        description={props.t('confirmDeleteCredentialDesc')}
        closeLabel={props.t('close')}
        onClose={() => setConfirmDeleteModal(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmDeleteModal(false)}>
              {props.t('cancel')}
            </Button>
            <Button variant="primary" onClick={handleDeleteCredential}>
              {props.t('deleteCredentialBtn')}
            </Button>
          </>
        }
      />
    </form>
  )
}
