import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

function listening(host, port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 500 })
    const done = (result) => {
      socket.destroy()
      resolve(result)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.once('timeout', () => done(false))
  })
}

export class LocalPreview {
  #child
  #controller = new AbortController()

  constructor(project, openUrl, log) {
    this.project = project
    this.openUrl = openUrl
    this.log = log
  }

  async open() {
    const { signal } = this.#controller
    signal.throwIfAborted()
    const url = new URL(this.project.url)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    if (!(await listening(host, port))) {
      let failure
      if (!this.#child) {
        signal.throwIfAborted()
        const child = spawn(process.env.SHELL || '/bin/sh', ['-c', this.project.startCommand], {
          cwd: this.project.directory,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        this.#child = child
        child.on('error', (error) => {
          failure = error
        })
        child.on('close', (code) => {
          if (this.#child === child) {
            this.#child = undefined
          }
          failure ??= new Error(`Mac dev command stopped (code ${code}).`)
        })
        child.stdout.on('data', (chunk) => this.log(chunk.toString()))
        child.stderr.on('data', (chunk) => this.log(chunk.toString()))
      }
      const deadline = Date.now() + 60_000
      while (!(await listening(host, port))) {
        signal.throwIfAborted()
        if (failure || !this.#child) {
          throw failure || new Error('Mac dev command stopped.')
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for ${url.href} on the Mac.`)
        }
        await delay(200, undefined, { signal })
      }
    }
    signal.throwIfAborted()
    await this.openUrl(url.href)
  }

  close() {
    this.#controller.abort()
    if (this.#child?.pid && this.#child.exitCode === null && this.#child.signalCode === null) {
      try {
        process.kill(-this.#child.pid, 'SIGTERM')
      } catch (error) {
        if (error.code !== 'ESRCH') {
          this.log(error.message)
        }
      }
    }
  }
}
