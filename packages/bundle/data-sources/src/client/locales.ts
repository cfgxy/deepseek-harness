export type DataSourcesLocaleKey =
  | 'title' | 'description' | 'summary' | 'emptySummary' | 'sources' | 'add' | 'empty' | 'edit' | 'label' | 'kind' | 'enabled' | 'disabled'
  | 'credentialRef' | 'credentialHint' | 'connection' | 'endpoint' | 'bucket' | 'region' | 'host' | 'port' | 'database' | 'knownHostsPath'
  | 'timeoutMs' | 'statementTimeoutMs' | 'policy' | 'maxBytes' | 'maxRows' | 'allowedPath' | 'allowedPrefix' | 'save' | 'saving' | 'saved'
  | 'test' | 'testing' | 'testSuccess' | 'testFailed' | 'testDisabledDirty' | 'testDisabledSource' | 'cancel' | 'discard' | 'unsaved'
  | 'advanced' | 'tls' | 'tlsEnabled' | 'tlsCaPath' | 'tlsServerName' | 'remove' | 'removeTitle' | 'removeDescription' | 'close'
  | 'confirmRemove' | 'continueEditing' | 'discardChanges' | 'discardTitle' | 'discardDescription' | 'loadFailed' | 'readOnly'
  | 'typeRequired' | 'sourceType' | 'selectType' | 'localGroup' | 'objectGroup' | 'remoteGroup' | 'databaseGroup' | 'ftpWarning'
  | 'mountedHint' | 'databaseHint' | 'validationFailed' | 'saveFailed' | 'saveConflict' | 'updating' | 'probeIdle'

export const en: Record<DataSourcesLocaleKey, string> = {
  title: 'Data sources', description: 'Reads only from the scope you specify. Source data is never changed.',
  summary: 'Configured data sources', emptySummary: 'No data sources configured', sources: 'Configured sources', add: 'Add source', empty: 'No data sources yet. Add files, object storage, or a database for your assistant to read.',
  edit: 'Edit source', label: 'Source name', kind: 'Type', enabled: 'Enabled', disabled: 'Disabled', credentialRef: 'Credential reference (optional)', credentialHint: 'Credentials are referenced by name on the host. Do not paste passwords or keys.',
  connection: 'Connection', endpoint: 'Endpoint', bucket: 'Bucket', region: 'Region', host: 'Host', port: 'Port', database: 'Database name', knownHostsPath: 'Known hosts file',
  timeoutMs: 'Connection timeout (ms)', statementTimeoutMs: 'Statement timeout (ms)', policy: 'Read policy', maxBytes: 'Max bytes per read', maxRows: 'Max rows per read', allowedPath: 'Allowed directory', allowedPrefix: 'Allowed object prefix',
  save: 'Save changes', saving: 'Saving…', saved: 'Changes saved.', test: 'Test connection', testing: 'Testing connection…', testSuccess: 'Connection succeeded.', testFailed: 'Connection test failed. Check the connection settings and the credential reference on the host.', testDisabledDirty: 'Save your changes first.', testDisabledSource: 'Enable this source first.', cancel: 'Cancel', discard: 'Discard changes', unsaved: 'Unsaved changes',
  advanced: 'Advanced settings', tls: 'TLS', tlsEnabled: 'Enable TLS', tlsCaPath: 'CA certificate path', tlsServerName: 'TLS server name', remove: 'Remove source', removeTitle: 'Remove data source?', removeDescription: 'Your assistant will no longer be able to read this source. Source data will not be deleted.', close: 'Close', confirmRemove: 'Remove source', continueEditing: 'Keep editing', discardChanges: 'Discard changes', discardTitle: 'Discard unsaved changes?', discardDescription: 'Your unsaved changes will be lost.', loadFailed: 'Data sources could not be loaded.', readOnly: 'You can view, but cannot change these settings.',
  typeRequired: 'Select a source type.', sourceType: 'Source type', selectType: 'Select a type', localGroup: 'Local & mounted folders', objectGroup: 'Object storage', remoteGroup: 'Remote files', databaseGroup: 'Read-only databases', ftpWarning: 'FTP is unencrypted. Prefer SFTP when possible.', mountedHint: 'Mount the share on the host before entering its path.', databaseHint: 'Use a database account with read-only permissions.', validationFailed: 'Review the highlighted fields.', saveFailed: 'Couldn’t save. Your changes were kept.', saveConflict: 'This source changed in another window. Your changes were kept; reload the latest settings before saving.', updating: 'Updating…', probeIdle: 'Not tested',
}

export const zh: Record<DataSourcesLocaleKey, string> = {
  title: '数据源', description: '仅从你指定的范围读取数据，不会修改源数据。',
  summary: '已配置数据源', emptySummary: '尚未配置数据源', sources: '已配置数据源', add: '添加数据源', empty: '还没有数据源。添加文件、对象存储或数据库，供助手读取。',
  edit: '编辑数据源', label: '数据源名称', kind: '类型', enabled: '已启用', disabled: '已停用', credentialRef: '凭据引用（可选）', credentialHint: '只填宿主机上的引用名，不要粘贴密码或密钥。',
  connection: '连接配置', endpoint: '端点', bucket: '存储桶', region: '区域', host: '主机', port: '端口', database: '数据库名称', knownHostsPath: '已知主机文件',
  timeoutMs: '连接超时（毫秒）', statementTimeoutMs: '语句超时（毫秒）', policy: '读取策略', maxBytes: '单次最多读取（字节）', maxRows: '单次最多返回的行数', allowedPath: '允许读取的目录', allowedPrefix: '允许读取的对象前缀',
  save: '保存更改', saving: '保存中…', saved: '更改已保存。', test: '测试连接', testing: '正在测试连接…', testSuccess: '连接成功。', testFailed: '连接测试失败。请检查连接配置和宿主机上的凭据引用。', testDisabledDirty: '请先保存更改。', testDisabledSource: '请先启用数据源。', cancel: '取消', discard: '放弃更改', unsaved: '未保存的更改',
  advanced: '高级设置', tls: 'TLS', tlsEnabled: '启用 TLS', tlsCaPath: 'CA 证书路径', tlsServerName: 'TLS 服务器名称', remove: '移除数据源', removeTitle: '移除数据源？', removeDescription: '助手将无法再读取此来源；源数据不会删除。', close: '关闭', confirmRemove: '移除数据源', continueEditing: '继续编辑', discardChanges: '放弃更改', discardTitle: '放弃未保存的更改？', discardDescription: '未保存的更改将会丢失。', loadFailed: '暂时无法加载数据源。', readOnly: '你可以查看，但不能修改这些设置。',
  typeRequired: '请选择数据源类型。', sourceType: '数据源类型', selectType: '选择类型', localGroup: '本地与挂载目录', objectGroup: '对象存储', remoteGroup: '远程文件', databaseGroup: '只读数据库', ftpWarning: 'FTP 不加密；优先使用 SFTP。', mountedHint: '先在宿主机挂载，再填写挂载路径。', databaseHint: '请使用仅有读取权限的数据库账号。', validationFailed: '请检查标记的字段。', saveFailed: '未能保存，已保留更改。', saveConflict: '此数据源已在另一窗口更改。已保留你的更改；请重新加载最新设置后再保存。', updating: '更新中…', probeIdle: '尚未测试',
}
