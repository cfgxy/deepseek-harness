export type DataSourcesLocaleKey =
  | 'title' | 'description' | 'summary' | 'emptySummary' | 'sources' | 'add' | 'empty' | 'edit' | 'label' | 'id' | 'revision' | 'kind'
  | 'enabled' | 'credentialRef' | 'connection' | 'endpoint' | 'bucket' | 'region' | 'host' | 'port' | 'database' | 'knownHostsPath'
  | 'timeoutMs' | 'statementTimeoutMs' | 'policy' | 'maxBytes' | 'maxRows' | 'allowedPath' | 'allowedPrefix' | 'save' | 'test'

export const en: Record<DataSourcesLocaleKey, string> = {
  title: 'Data sources', description: 'Configure read-only sources. Credentials are referenced by name and stay outside these settings.',
  summary: 'Configured data sources', emptySummary: 'No data sources configured', sources: 'Configured sources', add: 'Add source', empty: 'Add a source to begin.',
  edit: 'Edit source', label: 'Label', id: 'Source ID', revision: 'Revision', kind: 'Type', enabled: 'Enabled', credentialRef: 'Credential reference',
  connection: 'Connection', endpoint: 'Endpoint', bucket: 'Bucket', region: 'Region', host: 'Host', port: 'Port', database: 'Database', knownHostsPath: 'Known hosts path',
  timeoutMs: 'Connection timeout (ms)', statementTimeoutMs: 'Statement timeout (ms)', policy: 'Read policy', maxBytes: 'Maximum bytes', maxRows: 'Maximum rows',
  allowedPath: 'Allowed path', allowedPrefix: 'Allowed prefix', save: 'Save source', test: 'Test connection',
}

export const zh: Record<DataSourcesLocaleKey, string> = {
  title: '数据源', description: '配置只读数据源。凭据仅以引用名称出现，不会写入这些设置。',
  summary: '已配置数据源', emptySummary: '尚未配置数据源', sources: '已配置数据源', add: '添加数据源', empty: '添加一个数据源后开始配置。',
  edit: '编辑数据源', label: '名称', id: '数据源 ID', revision: '修订版本', kind: '类型', enabled: '启用', credentialRef: '凭据引用',
  connection: '连接', endpoint: '端点', bucket: '存储桶', region: '区域', host: '主机', port: '端口', database: '数据库', knownHostsPath: 'Known hosts 路径',
  timeoutMs: '连接超时（毫秒）', statementTimeoutMs: '语句超时（毫秒）', policy: '读取策略', maxBytes: '最大字节数', maxRows: '最大行数',
  allowedPath: '允许路径', allowedPrefix: '允许前缀', save: '保存数据源', test: '测试连接',
}
