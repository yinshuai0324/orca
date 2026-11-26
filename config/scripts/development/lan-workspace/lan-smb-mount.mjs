import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'
import { quotePosixShell } from '../../../../src/shared/shell/launch/shell-argument-quoting.ts'
import { buildSmbServer } from './build-smb-server.mjs'
import { remoteToolPath } from './lan-workspace-mount.mjs'

const loopback = '127.0.0.1'
const mountPath = '/private/tmp/orca-smb.XXXXXXXXXX'

function reason(code, message) {
  return Object.assign(new Error(message), { name: 'LanWorkspacePrerequisiteError', reason: code })
}

function mountScript(port) {
  return `set -eu
umask 077
test -x /sbin/mount_smbfs || exit 48
path=$(/usr/bin/mktemp -d ${mountPath})
mounted=0
cleanup() {
  if [ "$mounted" -eq 1 ]; then
    /sbin/umount "$path" || /sbin/umount -f "$path" || return
  fi
  /bin/rmdir "$path"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
LC_ALL=C /sbin/mount_smbfs -o nobrowse,soft,forcenewsession "//orca@${loopback}:${port}/project" "$path"
mounted=1
printf '\\nORCA_SMB_READY %s\\n' "$path"
IFS= read -r stop || true
`
}

export class LanSmbMount {
  #child
  #channel
  #channelDone
  #forwardedPort
  #sockets = new Set()
  #abort = new AbortController()
  #closing

  constructor(ssh, runRemote, onSave, onLost) {
    this.ssh = ssh
    this.runRemote = runRemote
    this.onSave = onSave
    this.onLost = onLost
  }

  async open(directory) {
    const { signal } = this.#abort
    const executable = await buildSmbServer().catch(() => {
      throw reason('smb-helper', 'Orca could not build the local SMB helper.')
    })
    signal.throwIfAborted()
    const password = randomBytes(24).toString('hex')
    const port = await this.#startServer(executable, directory, password)
    signal.throwIfAborted()
    const remotePort = await this.#forward(port)
    signal.throwIfAborted()
    const listening = await this.runRemote(
      `/usr/sbin/netstat -an -p tcp | /usr/bin/awk '$6 == "LISTEN" && $4 ~ /\\.${remotePort}$/ { print $4 }'`
    )
    if (listening.code !== 0 || listening.stdout !== `${loopback}.${remotePort}`) {
      throw reason(
        'smb-forward-bind',
        'The SSH server could not restrict SMB forwarding to its loopback interface.'
      )
    }
    signal.throwIfAborted()
    this.path = await this.#mount(remotePort, password)
    const path = quotePosixShell(this.path)
    this.shellDirectory = `${remoteToolPath}\n/sbin/mount | /usr/bin/grep -F -q " on ${this.path} (smbfs" && cd -- ${path}`
    return this.path
  }

  #startServer(executable, directory, password) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [directory], { stdio: ['pipe', 'pipe', 'ignore'] })
      this.#child = child
      const lines = createInterface({ input: child.stdout })
      let ready = false
      const error = () => reason('smb-helper', 'Orca could not start the local SMB helper.')
      const timeout = setTimeout(() => reject(error()), 5_000)
      const ended = () => {
        clearTimeout(timeout)
        if (ready && !this.#abort.signal.aborted) {
          this.onLost()
        } else {
          reject(error())
        }
      }
      child.once('error', ended)
      child.once('exit', ended)
      child.stdin.on('error', () => {})
      lines.on('line', (line) => {
        const match = /^port (\d+)$/.exec(line)
        if (!ready && match && Number(match[1]) > 0 && Number(match[1]) <= 65_535) {
          ready = true
          clearTimeout(timeout)
          resolve(Number(match[1]))
        } else if (ready && line === 'saved' && !this.#abort.signal.aborted) {
          this.onSave()
        }
      })
      child.stdin.write(`${password}\n`)
    })
  }

  #forward(localPort) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(reason('smb-forward', 'SSH did not open the SMB reverse tunnel.')),
        10_000
      )
      this.ssh.forwardIn(loopback, 0, (error, port) => {
        clearTimeout(timeout)
        if (error || !Number.isInteger(port) || port < 1 || port > 65_535) {
          reject(reason('smb-forward', 'The remote SSH server refused SMB reverse forwarding.'))
          return
        }
        if (this.#abort.signal.aborted) {
          this.#stopForward(port)
          reject(this.#abort.signal.reason)
          return
        }
        this.#forwardedPort = port
        this.ssh.on('tcp connection', (details, accept, rejectConnection) => {
          if (
            details.destIP !== loopback ||
            details.destPort !== port ||
            this.#abort.signal.aborted
          ) {
            rejectConnection()
            return
          }
          const channel = accept()
          const socket = createConnection({ host: loopback, port: localPort })
          this.#sockets.add(socket)
          channel.on('error', () => socket.destroy())
          channel.once('close', () => socket.destroy())
          socket.on('error', () => channel.destroy())
          socket.once('close', () => {
            this.#sockets.delete(socket)
            channel.destroy()
          })
          channel.pipe(socket).pipe(channel)
        })
        resolve(port)
      })
    })
  }

  #mount(port, password) {
    return new Promise((resolve, reject) => {
      let output = ''
      let ready = false
      let supplied = false
      const { signal } = this.#abort
      const timeout = setTimeout(
        () => reject(reason('smb-mount', 'The remote SMB mount timed out.')),
        20_000
      )
      const command = `/bin/sh -c ${quotePosixShell(mountScript(port))}`
      this.ssh.exec(command, { pty: { term: 'dumb', rows: 24, cols: 80 } }, (error, channel) => {
        if (error || signal.aborted) {
          clearTimeout(timeout)
          channel?.destroy()
          reject(error || signal.reason)
          return
        }
        this.#channel = channel
        this.#channelDone = new Promise((ended) => {
          channel.once('close', (code) => {
            ended()
            clearTimeout(timeout)
            if (ready && !signal.aborted) {
              this.onLost()
            } else {
              reject(
                code === 48
                  ? reason('missing-mount-smbfs', 'The remote Mac could not find mount_smbfs.')
                  : reason('smb-mount', 'The remote Mac could not mount the project over SMB.')
              )
            }
          })
        })
        channel.on('error', () => channel.destroy())
        channel.on('data', (chunk) => {
          if (ready || signal.aborted) {
            return
          }
          output = (output + chunk.toString()).slice(-2048)
          const match =
            /(?:^|\n)ORCA_SMB_READY (\/private\/tmp\/orca-smb\.[a-z0-9]{10})\r?\n/i.exec(output)
          if (match) {
            ready = true
            output = ''
            clearTimeout(timeout)
            resolve(match[1])
          } else if (!supplied && /(?:^|\n)Password for 127\.0\.0\.1: *$/.test(output)) {
            supplied = true
            channel.write(`${password}\n`)
          }
        })
        channel.stderr.resume()
      })
    })
  }

  close() {
    this.#closing ??= this.#release()
    return this.#closing
  }

  #stopForward(port) {
    try {
      this.ssh.unforwardIn(loopback, port, () => {})
    } catch {
      // SSH already removed its listener when the connection closed.
    }
  }

  async #release() {
    this.#abort.abort()
    if (this.#channel?.writable) {
      this.#channel.end('\n')
      let timer
      await Promise.race([
        this.#channelDone,
        new Promise((resolve) => {
          timer = setTimeout(resolve, 3_000)
        })
      ])
      clearTimeout(timer)
      this.#channel.destroy()
    }
    if (this.#forwardedPort) {
      this.#stopForward(this.#forwardedPort)
    }
    for (const socket of this.#sockets) {
      socket.destroy()
    }
    this.#child?.stdin.destroy()
    this.#child?.kill()
  }
}
