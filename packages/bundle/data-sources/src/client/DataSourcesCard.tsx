import { useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DataSourceDraft, DataSourcesCardFace, SourceKind } from './settings-controller.ts'

export type DataSourcesCardProps = PropsRuntime<'plugins.item'> & PropsLocale<'settings.dataSources'> & InjectFace<DataSourcesCardFace>

const kinds: readonly SourceKind[] = ['local-directory', 's3', 'sftp', 'mysql', 'postgresql']

function copy(source: DataSourceDraft): DataSourceDraft { return structuredClone(source) }

/** Render one configured source without ever placing a credential value in the DOM. */
export function DataSourcesCard(props: DataSourcesCardProps) {
  const state = props.useDataSourcesSettings(snapshot => snapshot)
  const [selected, setSelected] = useState<string | undefined>()
  const source = state.sources.find(candidate => candidate.id === selected) ?? state.sources[0]
  const [draft, setDraft] = useState<DataSourceDraft | undefined>(source === undefined ? undefined : copy(source))

  useEffect(() => { setDraft(source === undefined ? undefined : copy(source)) }, [source?.id, source?.revision])
  if (props.view === 'summary') return state.sources.length === 0 ? props.t('emptySummary') : props.t('summary')
  const disabled = !state.available || !state.writable
  const update = (path: 'id' | 'revision' | 'label' | 'credentialRef', value: string) => {
    if (draft !== undefined) setDraft({ ...draft, [path]: value })
  }
  const updateConnection = (field: keyof DataSourceDraft['connection'], value: string) => {
    if (draft !== undefined) setDraft({ ...draft, connection: { ...draft.connection, [field]: value } })
  }
  const updatePolicy = (field: keyof DataSourceDraft['policy'], value: string) => {
    if (draft !== undefined) setDraft({ ...draft, policy: { ...draft.policy, [field]: value } })
  }
  const field = (label: string, value: string, onChange: (value: string) => void, name: string) => (
    <label htmlFor={`plugin-config-data-sources-${name}`}>
      {label}<Input id={`plugin-config-data-sources-${name}`} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} />
    </label>
  )

  const probe = draft === undefined ? undefined : state.probes[draft.id]
  return <section aria-label={props.t('title')}>
    <p>{props.t('description')}</p>
    <div role="list" aria-label={props.t('sources')}>
      {state.sources.map(item => <div role="listitem" key={item.id}>
        <button type="button" aria-current={item.id === source?.id} onClick={() => setSelected(item.id)}>
          <strong>{item.label || item.id}</strong> <span>{item.kind}</span>
        </button>
      </div>)}
    </div>
    <Button variant="outline" disabled={disabled} onClick={props.add}>{props.t('add')}</Button>
    {draft === undefined ? <p>{props.t('empty')}</p> : <form onSubmit={(event) => { event.preventDefault(); props.save(draft) }}>
      <h3>{props.t('edit')}</h3>
      {field(props.t('label'), draft.label, value => update('label', value), 'label')}
      <label htmlFor="plugin-config-data-sources-id">{props.t('id')}<Input id="plugin-config-data-sources-id" value={draft.id} readOnly /></label>
      {field(props.t('revision'), draft.revision, value => update('revision', value), 'revision')}
      <label htmlFor="plugin-config-data-sources-kind">{props.t('kind')}
        <select id="plugin-config-data-sources-kind" value={draft.kind} disabled={disabled} onChange={event => setDraft({ ...draft, kind: event.target.value as SourceKind })}>
          {kinds.map(kind => <option key={kind} value={kind}>{kind}</option>)}
        </select>
      </label>
      <label><input type="checkbox" checked={draft.enabled} disabled={disabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /> {props.t('enabled')}</label>
      {field(props.t('credentialRef'), draft.credentialRef, value => update('credentialRef', value), 'credential-reference')}
      <fieldset><legend>{props.t('connection')}</legend>
        {field(props.t('endpoint'), draft.connection.endpoint, value => updateConnection('endpoint', value), 'endpoint')}
        {field(props.t('bucket'), draft.connection.bucket, value => updateConnection('bucket', value), 'bucket')}
        {field(props.t('region'), draft.connection.region, value => updateConnection('region', value), 'region')}
        {field(props.t('host'), draft.connection.host, value => updateConnection('host', value), 'host')}
        {field(props.t('port'), draft.connection.port, value => updateConnection('port', value), 'port')}
        {field(props.t('database'), draft.connection.database, value => updateConnection('database', value), 'database')}
        {field(props.t('knownHostsPath'), draft.connection.knownHostsPath, value => updateConnection('knownHostsPath', value), 'known-hosts')}
        {field(props.t('timeoutMs'), draft.connection.timeoutMs, value => updateConnection('timeoutMs', value), 'timeout')}
        {field(props.t('statementTimeoutMs'), draft.connection.statementTimeoutMs, value => updateConnection('statementTimeoutMs', value), 'statement-timeout')}
      </fieldset>
      <fieldset><legend>{props.t('policy')}</legend>
        {field(props.t('maxBytes'), draft.policy.maxBytes, value => updatePolicy('maxBytes', value), 'max-bytes')}
        {field(props.t('maxRows'), draft.policy.maxRows, value => updatePolicy('maxRows', value), 'max-rows')}
        {field(props.t('allowedPath'), draft.policy.allowedPath, value => updatePolicy('allowedPath', value), 'allowed-path')}
        {field(props.t('allowedPrefix'), draft.policy.allowedPrefix, value => updatePolicy('allowedPrefix', value), 'allowed-prefix')}
      </fieldset>
      <Button variant="primary" disabled={disabled} type="submit">{props.t('save')}</Button>
      <Button variant="outline" disabled={disabled || probe?.pending === true} onClick={() => props.test(draft.id)}>{props.t('test')}</Button>
      {probe === undefined ? null : <p role="status">{probe.message}</p>}
    </form>}
  </section>
}
