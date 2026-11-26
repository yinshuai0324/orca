import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { realpath, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { serveProjectFiles } from './project-sftp.mjs'
import {
  mountFailureError,
  prepareRemoteMount,
  readRemoteMount,
  remoteToolPath
} from './lan-workspace-mount.mjs'
import { LanWorkspacePty } from './lan-workspace-pty.mjs'
import { LanSmbMount } from './lan-smb-mount.mjs'

const { Client } = createRequire(import.meta.url)('ssh2')

function appendText(previous, chunk) {
  return (previous + chunk.toString()).slice(-8192)
}

function closeSshChannel(channel) {
  channel.close()
  channel.destroy()
}

function runRemote(ssh, command, { timeout = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let channel
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (channel) {
        closeSshChannel(channel)
      }
      reject(new Error('Remote command timed out.'))
    }, timeout)

    ssh.exec(command, (error, opened) => {
      if (error) {
        clearTimeout(timer)
        reject(error)
        return
      }
      if (timedOut) {
        closeSshChannel(opened)
        return
      }
      channel = opened
      channel.stderr.on('data', (chunk) => {
        stderr = appendText(stderr, chunk)
      })
      channel.on('error', (channelError) => {
        clearTimeout(timer)
        reject(channelError)
      })
      channel.on('data', (chunk) => {
        stdout = appendText(stdout, chunk)
      })
      channel.once('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })
      })
      channel.end()
    })
  })
}

export function validateSshConnection(config) {
  if (
    !isIP(config?.host ?? '') ||
    typeof config.username !== 'string' ||
    !config.username.trim() ||
    typeof config.password !== 'string' ||
    !config.password
  ) {
    throw new Error('Enter the remote IP address, SSH username, and password.')
  }
}

export async function validateProject(config) {
  if (typeof config.directory !== 'string' || !isAbsolute(config.directory)) {
    throw new Error('Choose an absolute path to the project on this Mac.')
  }
  const directory = await realpath(config.directory)
  if (!(await stat(directory)).isDirectory() || directory === '/') {
    throw new Error('Choose a project directory.')
  }
  return directory
}

export function validatePreview({ directory, startCommand, previewUrl }) {
  if (typeof startCommand !== 'string' || !startCommand.trim()) {
    throw new Error('Enter the local project start command.')
  }
  if (typeof previewUrl !== 'string' || !URL.canParse(previewUrl)) {
    throw new Error('Use a local HTTP or HTTPS preview URL.')
  }
  const url = new URL(previewUrl)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error('Use a local HTTP or HTTPS preview URL.')
  }
  return { directory, startCommand: startCommand.trim(), url: url.href }
}

export class LanSession {
  #ssh = new Client()
  #mount
  #mountChannel
  #smb
  #closed = false
  #authenticated = false
  #mounted = false
  terminalId = randomUUID()
  terminal = new LanWorkspacePty()

  constructor({ verifyHost, onDisconnect = () => {}, onRemoteSave = () => {} }) {
    this.verifyHost = verifyHost
    this.onDisconnect = onDisconnect
    this.onRemoteSave = onRemoteSave
    this.#ssh.on('error', () => {})
    this.#ssh.once('close', () => {
      if (!this.#closed) {
        void this.close()
        onDisconnect()
      }
    })
  }

  async open({ host, username, password, port = 22 }, projectDirectory) {
    await new Promise((resolve, reject) => {
      this.#ssh.once('ready', resolve)
      this.#ssh.once('error', reject)
      this.#ssh.once('close', () => reject(new Error('SSH connection closed.')))
      this.#ssh.connect({
        host,
        port,
        username,
        password,
        readyTimeout: 20_000,
        keepaliveInterval: 10_000,
        tryKeyboard: true,
        hostVerifier: (key, checked) => {
          const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
          void Promise.resolve()
            .then(() => this.verifyHost(host, fingerprint))
            .then(checked, () => checked(false))
        }
      })
      this.#ssh.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
        finish(
          prompts.length === 1 && !prompts[0].echo && /password/i.test(prompts[0].prompt)
            ? [password]
            : []
        )
      })
    })

    if (this.#closed) {
      throw new Error('SSH connection closed.')
    }
    this.#authenticated = true
    if (projectDirectory === null) {
      return { path: null, terminalId: this.terminalId }
    }

    const platform = await runRemote(this.#ssh, `printf 'ORCA_PLATFORM=%s\\n' "$(uname -s)"`)
    if (this.#closed) {
      throw new Error('SSH connection closed.')
    }
    if (platform.code === 0 && platform.stdout.split('\n').includes('ORCA_PLATFORM=Darwin')) {
      this.#smb = new LanSmbMount(
        this.#ssh,
        (command) => runRemote(this.#ssh, command),
        this.onRemoteSave,
        () => {
          if (this.#mounted && !this.#closed) {
            void this.close()
            this.onDisconnect()
          }
        }
      )
      const path = await this.#smb.open(projectDirectory)
      if (this.#closed) {
        throw new Error('SSH connection closed.')
      }
      this.#mounted = true
      return { path, terminalId: this.terminalId }
    }

    const mount = readRemoteMount(await runRemote(this.#ssh, prepareRemoteMount))
    this.#mount = mount
    let mountFailure
    let mountStderr = ''
    this.#mountChannel = await new Promise((resolve, reject) => {
      this.#ssh.exec(mount.start, (error, channel) => (error ? reject(error) : resolve(channel)))
    })
    const channel = this.#mountChannel
    channel.stderr.on('data', (chunk) => {
      mountStderr = appendText(mountStderr, chunk)
    })
    channel.once('close', () => {
      mountFailure = mountFailureError(mount, mountStderr || 'Remote SSHFS closed.')
      if (this.#mounted && !this.#closed) {
        void this.close()
        this.onDisconnect()
      }
    })
    channel.on('error', (error) => {
      mountFailure = error
    })

    serveProjectFiles(channel, projectDirectory, (error) => {
      mountFailure = error
      closeSshChannel(channel)
    })

    const deadline = Date.now() + 15_000
    while (!this.#closed && Date.now() < deadline) {
      if (mountFailure) {
        throw mountFailure
      }
      if ((await runRemote(this.#ssh, mount.check, { timeout: 3_000 })).code === 0) {
        if (mountFailure || this.#closed) {
          throw mountFailure || new Error('SSH connection closed.')
        }
        this.#mounted = true
        return { path: mount.path, terminalId: this.terminalId }
      }
      await delay(200)
    }
    throw mountFailureError(mount, mountStderr || 'Remote SSHFS mount did not become ready.')
  }

  async openTerminal(input, emit) {
    if (!this.#authenticated || this.#closed || ((this.#mount || this.#smb) && !this.#mounted)) {
      throw new Error('Connect to the remote host first.')
    }
    const directory =
      this.#smb?.shellDirectory ?? this.#mount?.shellDirectory ?? `${remoteToolPath}\ncd -- "$HOME"`
    await this.terminal.open(this.#ssh, `${directory} && exec "\${SHELL:-/bin/sh}" -i`, input, emit)
  }

  async close() {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.#authenticated = false
    this.#mounted = false
    this.terminal.close()
    await this.#smb?.close()
    if (this.#mount) {
      await runRemote(this.#ssh, this.#mount.cleanup, { timeout: 3_000 }).catch(() => {})
    }
    if (this.#mountChannel) {
      closeSshChannel(this.#mountChannel)
    }
    this.#ssh.end()
    this.#ssh.destroy()
  }
}
