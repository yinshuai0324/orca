import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { realpath, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { serveProjectFiles } from './project-sftp.mjs'
import { prepareRemoteMount, readRemoteMount } from './lan-workspace-mount.mjs'
import { discoverRemoteAgents, getRemoteAgent, readRemoteAgents } from './lan-workspace-agent.mjs'

const { Client } = createRequire(import.meta.url)('ssh2')
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
  #mount
  #mountChannel
  #closed = false
  #mounted = false
  #running = false
  #agents = []
  #sessions = new Map()

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
      if ((await runRemote(this.#ssh, mount.check, { timeout: 3_000 })).code === 0) {
        if (mountFailure || this.#closed) {
          throw mountFailure || new Error('SSH connection closed.')
        }
        const agents = readRemoteAgents(await runRemote(this.#ssh, discoverRemoteAgents))
        if (mountFailure || this.#closed) {
          throw mountFailure || new Error('SSH connection closed.')
        }
        this.#agents = agents
        this.#mounted = true
        return { path: mount.path, agents }
      }
      await delay(200)
    }
    throw new Error(mountStderr || 'Remote SSHFS mount did not become ready.')
  }

  async runTurn(agent, prompt, onMessage) {
    if (!this.#mounted || this.#closed || !this.#mountChannel || this.#mountChannel.destroyed) {
      throw new Error('Connect and mount the project first.')
    }
    if (this.#running) {
      throw new Error('Wait for the current turn to finish.')
    }
    const adapter = getRemoteAgent(agent)
    if (!adapter || !this.#agents.includes(agent)) {
      throw new Error('Choose an AI CLI available on the remote host.')
    }
    this.#running = true
    try {
      const command = `${this.#mount.taskDirectory} && exec ${adapter.command(this.#sessions.get(agent))}`
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
          const update = adapter.parse(event)
          if (
            typeof update.sessionId === 'string' &&
            /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(update.sessionId)
          ) {
            this.#sessions.set(agent, update.sessionId)
          }
          if (typeof update.answer === 'string' && update.answer) {
            onMessage(update.answer)
          }
          if (update.completed) {
            completed = true
          }
          if (update.error) {
            turnError = update.error
          }
        }
      })
      if (!completed || result.code !== 0 || turnError) {
        throw new Error(
          turnError || result.stderr || `${adapter.name} did not report a successful turn.`
        )
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
