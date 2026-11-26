const outputHighWater = 256 * 1024
const outputLowWater = 128 * 1024
const inputLimit = 256 * 1024

function readSize(input) {
  const { cols, rows } = input ?? {}
  return Number.isInteger(cols) &&
    cols >= 2 &&
    cols <= 1_000 &&
    Number.isInteger(rows) &&
    rows >= 1 &&
    rows <= 500
    ? { cols, rows }
    : null
}

export class LanWorkspacePty {
  #channel
  #closed = false
  #opening = false
  #pendingChars = 0

  async open(ssh, command, input, emit) {
    const size = readSize(input)
    if (!size || this.#closed || this.#opening || this.#channel) {
      throw new Error('Could not open the remote terminal.')
    }
    this.#opening = true
    try {
      const channel = await new Promise((resolve, reject) => {
        ssh.exec(command, { pty: { ...size, term: 'xterm-256color' } }, (error, stream) => {
          if (error) {
            reject(error)
          } else {
            resolve(stream)
          }
        })
      })
      if (this.#closed) {
        channel.destroy()
        throw new Error('SSH connection closed.')
      }
      this.#channel = channel
      channel.setEncoding('utf8')
      channel.on('data', (data) => {
        this.#pendingChars += data.length
        if (this.#pendingChars >= outputHighWater) {
          channel.pause()
        }
        emit({ kind: 'terminal-data', data })
      })
      channel.on('error', () => channel.destroy())
      channel.once('close', (code, signal) => {
        if (this.#channel !== channel) {
          return
        }
        this.#channel = undefined
        this.#pendingChars = 0
        emit({ kind: 'terminal-exit', exitCode: !signal && Number.isInteger(code) ? code : null })
      })
    } finally {
      this.#opening = false
    }
  }

  write(data) {
    if (typeof data === 'string' && data.length > 0 && data.length <= inputLimit) {
      this.#channel?.write(data)
    }
  }

  resize(input) {
    const size = readSize(input)
    if (size) {
      this.#channel?.setWindow(size.rows, size.cols, 0, 0)
    }
  }

  ack(chars) {
    if (!Number.isSafeInteger(chars) || chars <= 0 || chars > this.#pendingChars) {
      return
    }
    this.#pendingChars -= chars
    if (this.#pendingChars < outputLowWater) {
      this.#channel?.resume()
    }
  }

  close() {
    this.#closed = true
    const channel = this.#channel
    this.#channel = undefined
    this.#pendingChars = 0
    channel?.close()
    channel?.destroy()
  }
}
