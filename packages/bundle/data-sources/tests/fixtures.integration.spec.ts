import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { LocalDirectoryConnector } from '../src/local-directory.ts'
import { MysqlConnector } from '../src/mysql.ts'
import { PostgreSqlConnector } from '../src/postgresql.ts'
import { S3Connector } from '../src/s3.ts'
import { SftpConnector } from '../src/sftp.ts'
import { ConnectorSupervisor } from '../src/supervisor.ts'
import type { CredentialResolver } from '../src/supervisor.ts'
import type { ReadRequest, SourceConfig } from '../src/types.ts'

const execFileAsync = promisify(execFile)
const dockerAvailable = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
const fixturePassword = 'fixture-password'
const s3AccessKey = 'fixture-access'
const s3Secret = 'fixture-secret'

interface Fixture {
  root: string
  local: string
  s3Port: number
  sftpPort: number
  mysqlPort: number
  postgresPort: number
  privateKey: string
  knownHosts: string
  wrongKnownHosts: string
  containers: string[]
}

function source(kind: SourceConfig['kind'], id: string = kind): SourceConfig {
  return { id, revision: 'fixture-v1', kind, label: id, enabled: true, policy: { maxBytes: 128, maxRows: 8 } }
}

function request(sourceId: string, operation: ReadRequest['operation'], input: Record<string, unknown>, maxBytes = 128): ReadRequest {
  return { apiVersion: 'v1', sourceId, operation, input, maxBytes, maxRows: 8 }
}

async function run(command: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { cwd })
  return stdout.trim()
}

async function hostPort(container: string, port: string): Promise<number> {
  const value = await run('docker', ['port', container, port])
  const match = value.match(/:(\d+)$/m)
  if (match === null) throw new Error(`fixture port not published: ${container}/${port}`)
  return Number(match[1])
}

async function eventually(assertion: () => Promise<void>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let failure: unknown
  while (Date.now() < deadline) {
    try { await assertion(); return } catch (error) { failure = error; await new Promise(resolve => setTimeout(resolve, 300)) }
  }
  throw failure
}

async function startFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-data-sources-fixture-'))
  const local = join(root, 'local')
  const ssh = join(root, 'ssh')
  await mkdir(local); await mkdir(ssh)
  await writeFile(join(local, 'report.txt'), 'local-fixture')
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(ssh, 'id_ed25519')])
  await mkdir(join(ssh, 'keys'))
  await writeFile(join(ssh, 'keys', 'fixture.pub'), await readFile(join(ssh, 'id_ed25519.pub')))
  await writeFile(join(root, 's3.json'), JSON.stringify({ identities: [{ name: 'fixture', credentials: [{ accessKey: s3AccessKey, secretKey: s3Secret }], actions: ['Read', 'Write', 'Admin'] }] }))
  await writeFile(join(root, 'postgres-init.sql'), `SET password_encryption = 'md5';\nALTER USER postgres PASSWORD '${fixturePassword}';\nCREATE TABLE fixture_rows (value TEXT);\nINSERT INTO fixture_rows VALUES ('postgres-fixture');\n`)

  const suffix = `${process.pid}-${Date.now()}`
  const names = [`dsh-ds-s3-${suffix}`, `dsh-ds-sftp-${suffix}`, `dsh-ds-mysql-${suffix}`, `dsh-ds-postgres-${suffix}`]
  try {
    await run('docker', ['run', '-d', '--rm', '--name', names[0]!, '-p', '127.0.0.1::8333', '-p', '127.0.0.1::8888', '-v', `${root}/s3.json:/etc/seaweedfs/s3.json:ro`, 'chrislusf/seaweedfs@sha256:7ca46aeae2f223b37e5d91593c17ab37738eec6df6ab69b48a0487f7643342b9', 'server', '-s3', '-s3.port=8333', '-s3.config=/etc/seaweedfs/s3.json'])
    await run('docker', ['run', '-d', '--rm', '--name', names[1]!, '-p', '127.0.0.1::22', '-v', `${ssh}/keys:/home/fixture/.ssh/keys:ro`, 'atmoz/sftp@sha256:0960390462a4441dbb63698d7c185b76a41ffcee7b78ff4adf275f3e66f9c475', `fixture:${fixturePassword}:1001`])
    await run('docker', ['run', '-d', '--rm', '--name', names[2]!, '-e', `MARIADB_ROOT_PASSWORD=${fixturePassword}`, '-e', 'MARIADB_ROOT_HOST=%', '-e', 'MARIADB_DATABASE=fixture', '-p', '127.0.0.1::3306', 'mariadb@sha256:e1d5495f445654134f226f55a41ce0da227116f6f27f283101f405c794d841fc'])
    await run('docker', ['run', '-d', '--rm', '--name', names[3]!, '-e', `POSTGRES_PASSWORD=${fixturePassword}`, '-e', 'POSTGRES_DB=fixture', '-e', 'POSTGRES_HOST_AUTH_METHOD=md5', '-p', '127.0.0.1::5432', '-v', `${root}/postgres-init.sql:/docker-entrypoint-initdb.d/10-fixture.sql:ro`, 'postgres@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f'])

    const [s3Port, filerPort, sftpPort, mysqlPort, postgresPort] = await Promise.all([
      hostPort(names[0]!, '8333/tcp'), hostPort(names[0]!, '8888/tcp'), hostPort(names[1]!, '22/tcp'), hostPort(names[2]!, '3306/tcp'), hostPort(names[3]!, '5432/tcp'),
    ])
    await eventually(async () => { await run('docker', ['exec', names[2]!, 'mariadb-admin', 'ping', '-h127.0.0.1', '-uroot', `-p${fixturePassword}`, '--silent']) })
    await eventually(async () => { await run('docker', ['exec', names[3]!, 'pg_isready', '-U', 'postgres', '-d', 'fixture']) })
    await eventually(async () => { const response = await fetch(`http://127.0.0.1:${filerPort}/`); if (!response.ok) throw new Error('filer not ready') })
    await run('docker', ['exec', names[2]!, 'mariadb', '-uroot', `-p${fixturePassword}`, '-e', "CREATE TABLE fixture.fixture_rows (value VARCHAR(64)); INSERT INTO fixture.fixture_rows VALUES ('mysql-fixture');"])
    const seeded = await fetch(`http://127.0.0.1:${filerPort}/buckets/fixture/reports/report.txt`, { method: 'PUT', body: 's3-fixture' })
    if (!seeded.ok) throw new Error(`cannot seed S3 fixture: ${seeded.status}`)
    await run('docker', ['exec', names[1]!, 'sh', '-c', "mkdir -p /home/fixture/upload && printf 'sftp-fixture' >/home/fixture/upload/report.txt && chown -R fixture:users /home/fixture/upload"])
    const knownHosts = join(ssh, 'known_hosts')
    let knownHostOutput = ''
    await eventually(async () => {
      knownHostOutput = await run('ssh-keyscan', ['-p', String(sftpPort), '127.0.0.1'])
      if (knownHostOutput.trim() === '') throw new Error('SFTP host key is not ready')
    })
    await writeFile(knownHosts, `${knownHostOutput}\n`)
    const sftpBatch = join(ssh, 'ready.batch')
    await writeFile(sftpBatch, 'ls /upload\n')
    await eventually(async () => {
      await run('sftp', ['-q', '-P', String(sftpPort), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`, '-i', join(ssh, 'id_ed25519'), '-b', sftpBatch, 'fixture@127.0.0.1'])
    })
    const wrongKnownHosts = join(ssh, 'wrong_known_hosts')
    await writeFile(wrongKnownHosts, '127.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEeWFAKEHOSTKEY0000000000000000000000000\n')
    return { root, local, s3Port, sftpPort, mysqlPort, postgresPort, privateKey: join(ssh, 'id_ed25519'), knownHosts, wrongKnownHosts, containers: names }
  } catch (error) {
    await Promise.allSettled(names.map(name => run('docker', ['rm', '-f', name])))
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function stopFixture(fixture: Fixture | undefined): Promise<void> {
  if (fixture === undefined) return
  await Promise.allSettled(fixture.containers.map(name => run('docker', ['rm', '-f', name])))
  await rm(fixture.root, { recursive: true, force: true })
}

describe.skipIf(!dockerAvailable)('data-source isolated connector fixtures', () => {
  let fixture: Fixture
  let supervisor: ConnectorSupervisor

  beforeAll(async () => {
    fixture = await startFixture()
    const privateKey = await readFile(fixture.privateKey, 'utf8')
    const sources: SourceConfig[] = [
      { ...source('local-directory'), policy: { maxBytes: 128, maxRows: 8, allowedPath: fixture.local } },
      { ...source('s3'), credentialRef: 'S3_OK', connection: { endpoint: `http://127.0.0.1:${fixture.s3Port}`, bucket: 'fixture', region: 'us-east-1', timeoutMs: 5_000 }, policy: { maxBytes: 128, maxRows: 8, allowedPrefix: 'reports/' } },
      { ...source('s3', 's3-wrong-credential'), credentialRef: 'S3_BAD', connection: { endpoint: `http://127.0.0.1:${fixture.s3Port}`, bucket: 'fixture', region: 'us-east-1', timeoutMs: 5_000 }, policy: { maxBytes: 128, maxRows: 8, allowedPrefix: 'reports/' } },
      { ...source('sftp'), credentialRef: 'SFTP_OK', connection: { host: '127.0.0.1', port: fixture.sftpPort, knownHostsPath: fixture.knownHosts, timeoutMs: 5_000 }, policy: { maxBytes: 128, maxRows: 8, allowedPath: '/upload' } },
      { ...source('sftp', 'sftp-wrong-host'), credentialRef: 'SFTP_OK', connection: { host: '127.0.0.1', port: fixture.sftpPort, knownHostsPath: fixture.wrongKnownHosts, timeoutMs: 5_000 }, policy: { maxBytes: 128, maxRows: 8, allowedPath: '/upload' } },
      { ...source('sftp', 'sftp-wrong-credential'), credentialRef: 'SFTP_BAD', connection: { host: '127.0.0.1', port: fixture.sftpPort, knownHostsPath: fixture.knownHosts, timeoutMs: 5_000 }, policy: { maxBytes: 128, maxRows: 8, allowedPath: '/upload' } },
      { ...source('mysql'), credentialRef: 'MYSQL_OK', connection: { host: '127.0.0.1', port: fixture.mysqlPort, database: 'fixture', timeoutMs: 5_000, statementTimeoutMs: 2_000 }, policy: { maxBytes: 128, maxRows: 8 } },
      { ...source('mysql', 'mysql-wrong-credential'), credentialRef: 'MYSQL_BAD', connection: { host: '127.0.0.1', port: fixture.mysqlPort, database: 'fixture', timeoutMs: 5_000, statementTimeoutMs: 2_000 }, policy: { maxBytes: 128, maxRows: 8 } },
      { ...source('postgresql'), credentialRef: 'POSTGRES_OK', connection: { host: '127.0.0.1', port: fixture.postgresPort, database: 'fixture', timeoutMs: 5_000, statementTimeoutMs: 2_000 }, policy: { maxBytes: 128, maxRows: 8 } },
      { ...source('postgresql', 'postgresql-wrong-credential'), credentialRef: 'POSTGRES_BAD', connection: { host: '127.0.0.1', port: fixture.postgresPort, database: 'fixture', timeoutMs: 5_000, statementTimeoutMs: 2_000 }, policy: { maxBytes: 128, maxRows: 8 } },
    ]
    const credentials = new Map<string, string>([
      ['S3_OK', JSON.stringify({ accessKeyId: s3AccessKey, secretAccessKey: s3Secret })], ['S3_BAD', JSON.stringify({ accessKeyId: 'wrong-access', secretAccessKey: 'wrong-secret' })],
      ['SFTP_OK', JSON.stringify({ username: 'fixture', privateKey })], ['SFTP_BAD', JSON.stringify({ username: 'fixture', privateKey: 'not-a-private-key' })],
      ['MYSQL_OK', JSON.stringify({ username: 'root', password: fixturePassword })], ['MYSQL_BAD', JSON.stringify({ username: 'root', password: 'wrong-password' })],
      ['POSTGRES_OK', JSON.stringify({ username: 'postgres', password: fixturePassword })], ['POSTGRES_BAD', JSON.stringify({ username: 'postgres', password: 'wrong-password' })],
    ])
    const resolver: CredentialResolver = { resolve: async ref => ({ value: credentials.get(ref)! }) }
    supervisor = new ConnectorSupervisor(sources, [
      new LocalDirectoryConnector(), new S3Connector(), new SftpConnector(), new MysqlConnector(), new PostgreSqlConnector(),
    ], resolver)
  }, 90_000)

  afterAll(async () => { await stopFixture(fixture) })

  it('reads each fixture through the supervisor and protocol connectors', async () => {
    await expect(supervisor.execute(request('local-directory', 'object.read', { path: join(fixture.local, 'report.txt') }))).resolves.toMatchObject({ data: { content: 'local-fixture' }, truncated: false })
    await expect(supervisor.execute(request('s3', 'object.read', { path: 'reports/report.txt' }))).resolves.toMatchObject({ data: { content: 's3-fixture' }, truncated: false })
    await expect(supervisor.execute(request('sftp', 'object.read', { path: '/upload/report.txt' }))).resolves.toMatchObject({ data: { content: 'sftp-fixture' }, truncated: false })
    await expect(supervisor.execute(request('mysql', 'sql.query', { sql: 'SELECT value FROM fixture_rows' }))).resolves.toMatchObject({ data: { rows: [['mysql-fixture']] }, truncated: false })
    await expect(supervisor.execute(request('postgresql', 'sql.query', { sql: 'SELECT value FROM fixture_rows' }))).resolves.toMatchObject({ data: { rows: [['postgres-fixture']] }, truncated: false })
  }, 30_000)

  it('rejects write, path/prefix, known-host, and credential violations without bypassing the connector', async () => {
    await expect(supervisor.execute(request('mysql', 'sql.query', { sql: "INSERT INTO fixture_rows VALUES ('blocked')" }))).rejects.toThrow(/only one SELECT/i)
    await expect(supervisor.execute(request('postgresql', 'sql.query', { sql: "UPDATE fixture_rows SET value = 'blocked'" }))).rejects.toThrow(/only one SELECT/i)
    await expect(supervisor.execute(request('local-directory', 'object.read', { path: '../report.txt' }))).rejects.toThrow(/allow-list/i)
    await expect(supervisor.execute(request('s3', 'object.read', { path: 'outside/report.txt' }))).rejects.toThrow(/allow-list/i)
    await expect(supervisor.execute(request('sftp', 'object.read', { path: '/outside/report.txt' }))).rejects.toThrow(/allow-list/i)
    await expect(supervisor.execute(request('sftp-wrong-host', 'object.read', { path: '/upload/report.txt' }))).rejects.toThrow()
    await expect(supervisor.execute(request('sftp-wrong-credential', 'object.read', { path: '/upload/report.txt' }))).rejects.toThrow()
    await expect(supervisor.execute(request('s3-wrong-credential', 'object.read', { path: 'reports/report.txt' }))).rejects.toThrow()
    await expect(supervisor.execute(request('mysql-wrong-credential', 'sql.query', { sql: 'SELECT value FROM fixture_rows' }))).rejects.toThrow()
    await expect(supervisor.execute(request('postgresql-wrong-credential', 'sql.query', { sql: 'SELECT value FROM fixture_rows' }))).rejects.toThrow()
  }, 30_000)

  it('returns bounded results from actual connector reads', async () => {
    for (const [id, operation, input] of [
      ['local-directory', 'object.read', { path: join(fixture.local, 'report.txt') }], ['s3', 'object.read', { path: 'reports/report.txt' }], ['sftp', 'object.read', { path: '/upload/report.txt' }],
      ['mysql', 'sql.query', { sql: 'SELECT value FROM fixture_rows' }], ['postgresql', 'sql.query', { sql: 'SELECT value FROM fixture_rows' }],
    ] as const) {
      await expect(supervisor.execute(request(id, operation, input, 2))).resolves.toMatchObject({ truncated: true })
    }
  }, 30_000)
})
