import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceConnection } from './types.ts'

export interface ConnectedSocket {
  socket: net.Socket
  close: () => Promise<void>
}

/** Check if an IP address string is standard IPv4 */
function isIpv4(host: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host)
}

/** Helper to find an available local port for SSH forwarding */
async function getAvailableLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((err) => {
        if (err) reject(err)
        else resolve(port)
      })
    })
  })
}

/** Perform RFC 1928 SOCKS5 handshake over a connected socket */
async function connectSocks5(params: {
  proxyHost: string
  proxyPort: number
  targetHost: string
  targetPort: number
  username?: string | undefined
  password?: string | undefined
  timeoutMs: number
}): Promise<ConnectedSocket> {
  const { proxyHost, proxyPort, targetHost, targetPort, username, password, timeoutMs } = params
  const socket = net.createConnection({ host: proxyHost, port: proxyPort })

  const cleanup = async () => {
    socket.destroy()
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`data-sources: SOCKS5 proxy connection to ${proxyHost}:${proxyPort} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const onError = (err: Error) => {
      clearTimeout(timer)
      socket.destroy()
      reject(new Error(`data-sources: SOCKS5 proxy error: ${err.message}`))
    }

    socket.once('error', onError)
    socket.once('connect', () => {
      // 1. Send method negotiation
      const hasAuth = Boolean(username)
      const methods = hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00])
      socket.write(methods)

      let stage: 'method' | 'auth' | 'connect' = 'method'
      let buffer = Buffer.alloc(0)

      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])

        if (stage === 'method') {
          if (buffer.length < 2) return
          const ver = buffer[0]
          const selectedMethod = buffer[1]
          buffer = buffer.subarray(2)

          if (ver !== 0x05) {
            clearTimeout(timer)
            socket.destroy()
            reject(new Error('data-sources: unsupported SOCKS version from proxy'))
            return
          }

          if (selectedMethod === 0x02) {
            // Username/Password authentication
            stage = 'auth'
            const u = Buffer.from(username || '')
            const p = Buffer.from(password || '')
            const authReq = Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p])
            socket.write(authReq)
            return
          }

          if (selectedMethod === 0x00) {
            // No auth required, proceed to connect
            sendConnectCommand()
            return
          }

          clearTimeout(timer)
          socket.destroy()
          reject(new Error(`data-sources: SOCKS5 authentication method ${selectedMethod} not supported by proxy`))
          return
        }

        if (stage === 'auth') {
          if (buffer.length < 2) return
          const authStatus = buffer[1]
          buffer = buffer.subarray(2)

          if (authStatus !== 0x00) {
            clearTimeout(timer)
            socket.destroy()
            reject(new Error('data-sources: SOCKS5 username/password authentication failed'))
            return
          }

          sendConnectCommand()
          return
        }

        if (stage === 'connect') {
          if (buffer.length < 4) return
          const rep = buffer[1] ?? 0
          const atyp = buffer[3]

          let neededLen = 4
          if (atyp === 0x01) neededLen = 10 // IPv4 (4) + Port (2)
          else if (atyp === 0x03) {
            if (buffer.length < 5) return
            const domainLen = buffer[4] ?? 0
            neededLen = 5 + domainLen + 2
          } else if (atyp === 0x04) neededLen = 22 // IPv6 (16) + Port (2)

          if (buffer.length < neededLen) return

          if (rep !== 0x00) {
            clearTimeout(timer)
            socket.destroy()
            const errorMessages: Record<number, string> = {
              0x01: 'General SOCKS server failure',
              0x02: 'Connection not allowed by ruleset',
              0x03: 'Network unreachable',
              0x04: 'Host unreachable',
              0x05: 'Connection refused',
              0x06: 'TTL expired',
              0x07: 'Command not supported',
              0x08: 'Address type not supported',
            }
            reject(new Error(`data-sources: SOCKS5 connect failed: ${errorMessages[rep] || `code 0x0${rep.toString(16)}`}`))
            return
          }

          // Handshake complete! Unpipe listener and return socket.
          clearTimeout(timer)
          socket.removeListener('data', onData)
          socket.removeListener('error', onError)
          const remaining = buffer.subarray(neededLen)
          if (remaining.length > 0) socket.unshift(remaining)
          resolve()
        }
      }

      const sendConnectCommand = () => {
        stage = 'connect'
        let addrBuffer: Buffer
        if (isIpv4(targetHost)) {
          const parts = targetHost.split('.').map(Number)
          addrBuffer = Buffer.from([0x01, ...parts])
        } else {
          const hostBytes = Buffer.from(targetHost, 'utf8')
          addrBuffer = Buffer.concat([Buffer.from([0x03, hostBytes.length]), hostBytes])
        }
        const portBuffer = Buffer.alloc(2)
        portBuffer.writeUInt16BE(targetPort, 0)
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrBuffer, portBuffer]))
      }

      socket.on('data', onData)
    })
  })

  return { socket, close: cleanup }
}

/** OpenSSH local forwarding tunnel */
async function connectSshTunnel(params: {
  sshHost: string
  sshPort: number
  sshUsername: string
  authMode: 'password' | 'privateKey'
  password?: string | undefined
  privateKey?: string | undefined
  targetHost: string
  targetPort: number
  timeoutMs: number
}): Promise<ConnectedSocket> {
  const { sshHost, sshPort, sshUsername, authMode, password, privateKey, targetHost, targetPort, timeoutMs } = params
  const localPort = await getAvailableLocalPort()
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-ssh-tunnel-'))

  const args: string[] = [
    '-N',
    '-L',
    `127.0.0.1:${localPort}:${targetHost}:${targetPort}`,
    '-p',
    String(sshPort),
    '-l',
    sshUsername,
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'ConnectTimeout=10',
  ]

  const env: NodeJS.ProcessEnv = { ...process.env }

  if (authMode === 'privateKey' && privateKey) {
    const keyPath = join(tempDir, 'id_rsa')
    await writeFile(keyPath, `${privateKey.trim()}\n`, { mode: 0o600 })
    args.push('-i', keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes')
  } else if (authMode === 'password' && password) {
    const askpassScript = join(tempDir, 'askpass.sh')
    const pwdFile = join(tempDir, 'pwd.txt')
    await writeFile(pwdFile, password, { mode: 0o600 })
    await writeFile(askpassScript, `#!/bin/sh\ncat "${pwdFile}"\n`, { mode: 0o700 })
    env.SSH_ASKPASS = askpassScript
    env.SSH_ASKPASS_REQUIRE = 'force'
    env.DISPLAY = ':0'
    args.push('-o', 'BatchMode=no')
  } else {
    args.push('-o', 'BatchMode=yes')
  }

  args.push(sshHost)

  const child = spawn('ssh', args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let childExited = false
  let childStderr = ''

  child.stderr.on('data', (d: Buffer) => { childStderr += d.toString('utf8') })
  child.once('exit', (code) => {
    childExited = true
    if (code !== null && code !== 0) {
      childStderr = childStderr.trim()
    }
  })

  // Poll until localPort is listening or timeout
  const deadline = Date.now() + timeoutMs
  let connected = false

  while (Date.now() < deadline) {
    if (childExited) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw new Error(`data-sources: SSH tunnel process exited prematurely: ${childStderr || 'unknown error'}`)
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const testSocket = net.createConnection({ host: '127.0.0.1', port: localPort })
        testSocket.once('connect', () => {
          testSocket.destroy()
          resolve()
        })
        testSocket.once('error', (err) => {
          testSocket.destroy()
          reject(err)
        })
      })
      connected = true
      break
    } catch {
      await new Promise(r => setTimeout(r, 100))
    }
  }

  if (!connected) {
    child.kill('SIGTERM')
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    throw new Error(`data-sources: SSH tunnel failed to establish connection to 127.0.0.1:${localPort} within ${timeoutMs}ms`)
  }

  // Connect to the local tunnel port
  const socket = net.createConnection({ host: '127.0.0.1', port: localPort })

  const close = async () => {
    socket.destroy()
    child.kill('SIGTERM')
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }

  return { socket, close }
}

/**
 * Connect to the target host and port directly or via configured proxy (SSH Tunnel or SOCKS5).
 */
export async function connectSocket(
  connection: SourceConnection,
  timeoutMs: number,
): Promise<ConnectedSocket> {
  const host = connection.host
  const port = connection.port
  if (!host || !port) throw new Error('data-sources: connection host and port are required')

  const proxy = connection.proxy
  if (!proxy || proxy.type === 'none') {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`data-sources: connection to ${host}:${port} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve({ socket, close: async () => { socket.destroy() } })
      })
      socket.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  if (proxy.type === 'socks5') {
    const socks = proxy.socks5
    if (!socks?.host) throw new Error('data-sources: SOCKS5 proxy requires host')
    return await connectSocks5({
      proxyHost: socks.host,
      proxyPort: socks.port ?? 1080,
      targetHost: host,
      targetPort: port,
      username: socks.username,
      password: socks.password,
      timeoutMs,
    })
  }

  if (proxy.type === 'ssh') {
    const ssh = proxy.ssh
    if (!ssh?.host || !ssh.username) throw new Error('data-sources: SSH proxy requires host and username')
    return await connectSshTunnel({
      sshHost: ssh.host,
      sshPort: ssh.port ?? 22,
      sshUsername: ssh.username,
      authMode: ssh.authMode ?? (ssh.password ? 'password' : 'privateKey'),
      password: ssh.password,
      privateKey: ssh.privateKey,
      targetHost: host,
      targetPort: port,
      timeoutMs,
    })
  }

  throw new Error(`data-sources: unsupported proxy type ${(proxy as { type: string }).type}`)
}
