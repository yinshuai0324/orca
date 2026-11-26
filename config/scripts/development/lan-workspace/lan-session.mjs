import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { realpath, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { serveProjectFiles } from './project-sftp.mjs'
import { quotePosixShell } from '../../../../src/shared/shell/launch/shell-argument-quoting.ts'

const { Client } = createRequire(import.meta.url)('ssh2')
const remoteToolPath =
  'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin"'

const remoteMountCheck = `
orca_mounted() {
  if command -v mountpoint >/dev/null 2>&1; then
    mountpoint -q -- "$1"
    return
  fi
  while IFS=' ' read -r mount_id parent_id device root mount_path options; do
    if [ "$mount_path" = "$1" ]; then
      return 0
    fi
  done < /proc/self/mountinfo
  return 1
}
`

const remotePrerequisites = [
  {
    check: 'command -v sshfs >/dev/null 2>&1',
    status: 41,
    reason: 'missing-sshfs',
    message: 'SSH connected, but sshfs was not found in the remote PATH.'
  },
  {
    check: 'test -c /dev/fuse',
    status: 42,
    reason: 'missing-fuse-device',
    message: 'SSH connected, but the remote session has no /dev/fuse device.'
  },
  {
    check: '(command -v fusermount3 >/dev/null 2>&1 || command -v fusermount >/dev/null 2>&1)',
    status: 43,
    reason: 'missing-unmount-helper',
    message: 'SSH connected, but neither fusermount3 nor fusermount was found in the remote PATH.'
  },
  {
    check: '(command -v mountpoint >/dev/null 2>&1 || test -r /proc/self/mountinfo)',
    status: 44,
    reason: 'missing-mount-status',
    message: 'SSH connected, but the remote session cannot check which directories are mounted.'
  },
  {
    check: 'command -v codex >/dev/null 2>&1',
    status: 45,
    reason: 'missing-codex',
    message: 'SSH connected, but the Codex CLI was not found in the remote PATH.'
  }
]

class LanWorkspacePrerequisiteError extends Error {
  constructor({ reason, message }) {
    super(message)
    this.name = 'LanWorkspacePrerequisiteError'
    this.reason = reason
  }
}

const localDevInstructions =
  'Edit the files in the current workspace. This is a live mount of my Mac project. ' +
  'Leave dependency installation, build, dev server startup and browser preview to the Mac client.'

function appendText(previous, chunk) {
  return (previous + chunk.toString()).slice(-8192)
}

function closeSshChannel(channel) {
  channel.close()
  channel.destroy()
}

function runRemote(ssh, command, { input, timeout = 10_000, onOutput } = {}) {
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
      if (onOutput) {
        const lines = createInterface({ input: channel })
        lines.on('line', onOutput)
      } else {
        channel.on('data', (chunk) => {
          stdout = appendText(stdout, chunk)
        })
      }
      channel.once('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })
      })
      channel.end(input)
    })
  })
}

export async function validateProject(config) {
  if (
    !isIP(config?.host ?? '') ||
    typeof config.username !== 'string' ||
    !config.username.trim() ||
    typeof config.password !== 'string' ||
    !config.password
  ) {
    throw new Error('Enter the remote IP address, SSH username, and password.')
  }
  if (typeof config.directory !== 'string' || !isAbsolute(config.directory)) {
    throw new Error('Choose an absolute path to the project on this Mac.')
  }
  if (typeof config.startCommand !== 'string' || !config.startCommand.trim()) {
    throw new Error('Enter the local project start command.')
  }
  const url = new URL(config.previewUrl)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error('Use a local HTTP or HTTPS preview URL.')
  }
  const directory = await realpath(config.directory)
  if (!(await stat(directory)).isDirectory() || directory === '/') {
    throw new Error('Choose a project directory.')
  }
  return { directory, startCommand: config.startCommand.trim(), url: url.href }
}

export class LanSession {
  #ssh = new Client()
  #mountPath
  #mountChannel
  #closed = false
  #mounted = false
  #running = false
  #threadId

  constructor({ verifyHost, onDisconnect = () => {} }) {
    this.verifyHost = verifyHost
    this.onDisconnect = onDisconnect
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

    const prepared = await runRemote(
      this.#ssh,
      `
      ${remoteToolPath}
      ${remotePrerequisites.map(({ check, status }) => `${check} || exit ${status}`).join('\n')}
      mktemp -d /tmp/orca-workspace.XXXXXXXXXX
    `
    )
    const prerequisite = remotePrerequisites.find(({ status }) => status === prepared.code)
    if (prerequisite) {
      throw new LanWorkspacePrerequisiteError(prerequisite)
    }
    if (prepared.code !== 0 || !/^\/tmp\/orca-workspace\.[A-Za-z0-9]+$/.test(prepared.stdout)) {
      throw new Error(prepared.stderr || 'Could not prepare the remote mount directory.')
    }
    this.#mountPath = prepared.stdout
    const quotedMountPath = quotePosixShell(this.#mountPath)
    let mountFailure
    let mountStderr = ''
    this.#mountChannel = await new Promise((resolve, reject) => {
      this.#ssh.exec(
        `${remoteToolPath}; exec sshfs -f -o passive,dir_cache=no :/ ${quotedMountPath}`,
        (error, channel) => (error ? reject(error) : resolve(channel))
      )
    })
    const channel = this.#mountChannel
    channel.stderr.on('data', (chunk) => {
      mountStderr = appendText(mountStderr, chunk)
    })
    channel.once('close', () => {
      mountFailure = new Error(mountStderr || 'Remote SSHFS closed.')
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
      if (
        (
          await runRemote(
            this.#ssh,
            `${remoteToolPath}
${remoteMountCheck}
orca_mounted ${quotedMountPath}`,
            { timeout: 3_000 }
          )
        ).code === 0
      ) {
        if (mountFailure || this.#closed) {
          throw mountFailure || new Error('SSH connection closed.')
        }
        this.#mounted = true
        return this.#mountPath
      }
      await delay(200)
    }
    throw new Error(mountStderr || 'Remote SSHFS mount did not become ready.')
  }

  async runTurn(prompt, onMessage) {
    if (!this.#mounted || this.#closed || !this.#mountChannel || this.#mountChannel.destroyed) {
      throw new Error('Connect and mount the project first.')
    }
    if (this.#running) {
      throw new Error('Wait for the current turn to finish.')
    }
    this.#running = true
    try {
      const mount = quotePosixShell(this.#mountPath)
      const thread = this.#threadId ? ` resume ${quotePosixShell(this.#threadId)}` : ''
      const command =
        `${remoteToolPath}\n${remoteMountCheck}\norca_mounted ${mount} && cd -- ${mount} && ` +
        `exec codex --ask-for-approval never -c 'sandbox_mode="workspace-write"' exec${thread} --json --skip-git-repo-check -`
      let completed = false
      let turnError
      const result = await runRemote(this.#ssh, command, {
        input: `${localDevInstructions}\n\n${prompt}\n`,
        timeout: 30 * 60_000,
        onOutput: (line) => {
          let event
          try {
            event = JSON.parse(line)
          } catch {
            return
          }
          if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
            this.#threadId = event.thread_id
          }
          if (
            event.type === 'item.completed' &&
            event.item?.type === 'agent_message' &&
            typeof event.item.text === 'string'
          ) {
            onMessage(event.item.text)
          }
          if (event.type === 'turn.completed') {
            completed = true
          }
          if (event.type === 'turn.failed') {
            turnError = event.error?.message ?? 'Codex reported a failed turn.'
          }
        }
      })
      if (!completed || result.code !== 0 || turnError) {
        throw new Error(turnError || result.stderr || 'Codex did not report a successful turn.')
      }
    } finally {
      this.#running = false
    }
  }

  async close() {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.#mounted = false
    if (this.#mountPath) {
      const mount = quotePosixShell(this.#mountPath)
      await runRemote(
        this.#ssh,
        `
        ${remoteToolPath}
        ${remoteMountCheck}
        if orca_mounted ${mount}; then
          unmount=$(command -v fusermount3 || command -v fusermount)
          "$unmount" -uz -- ${mount} || exit 1
        fi
        rmdir -- ${mount}
      `,
        { timeout: 3_000 }
      ).catch(() => {})
    }
    if (this.#mountChannel) {
      closeSshChannel(this.#mountChannel)
    }
    this.#ssh.end()
    this.#ssh.destroy()
  }
}
