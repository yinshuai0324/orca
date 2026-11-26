import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
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
  #ssh
  #mount
  #mountChannel
  #smb
  #releaseTransport
  #abort = new AbortController()
  #closed = false
  #mounted = false
  #transportClosed = () => {
    if (!this.#closed) {
      void this.close()
      this.onDisconnect()
    }
  }
  terminalId = randomUUID()
  terminal = new LanWorkspacePty()

  constructor({ openSshTransport, onDisconnect = () => {}, onRemoteSave = () => {} }) {
    this.openSshTransport = openSshTransport
    this.onDisconnect = onDisconnect
    this.onRemoteSave = onRemoteSave
  }

  async open(targetId, projectDirectory) {
    const { client, release } = await this.openSshTransport(targetId, this.#abort.signal)
    if (this.#closed) {
      await release?.()
      throw new Error('SSH connection closed.')
    }
    this.#ssh = client
    this.#releaseTransport = release
    client.once('close', this.#transportClosed)
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
    if (!this.#ssh || this.#closed || ((this.#mount || this.#smb) && !this.#mounted)) {
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
    this.#abort.abort()
    this.#mounted = false
    this.#ssh?.off('close', this.#transportClosed)
    this.terminal.close()
    await this.#smb?.close()
    if (this.#mount) {
      await runRemote(this.#ssh, this.#mount.cleanup, { timeout: 3_000 }).catch(() => {})
    }
    if (this.#mountChannel) {
      closeSshChannel(this.#mountChannel)
    }
    await this.#releaseTransport?.()
  }
}
