import { LanSession, validatePreview, validateProject } from './lan-session.mjs'
import { LocalPreview } from './local-preview.mjs'

export function createLanWorkspaceController({ verifyHost, openPreview, emit }) {
  let session
  let preview
  let previewSettings
  let connecting = false
  let previewing = false
  let generation = 0

  async function disconnect() {
    generation += 1
    const current = session
    session = undefined
    previewSettings = undefined
    preview?.close()
    preview = undefined
    await current?.close()
  }

  async function connect(input) {
    if (connecting || session) {
      throw new Error('Disconnect the current workspace first.')
    }
    connecting = true
    const attempt = generation
    try {
      const directory = await validateProject(input)
      if (generation !== attempt) {
        throw new Error('SSH connection closed.')
      }
      const connection = new LanSession({
        verifyHost,
        onDisconnect: () => {
          if (session === connection) {
            void disconnect()
            emit({ kind: 'disconnected' })
          }
        }
      })
      session = connection
      const mount = await connection.open(input, directory)
      if (session !== connection) {
        throw new Error('SSH connection closed.')
      }
      previewSettings = {
        directory,
        startCommand: input.startCommand,
        previewUrl: input.previewUrl
      }
      return mount
    } catch (error) {
      await disconnect()
      throw error
    } finally {
      connecting = false
    }
  }

  async function startPreview() {
    if (!session || !previewSettings || previewing) {
      throw new Error('Connect a workspace before opening the local preview.')
    }
    const connection = session
    previewing = true
    try {
      preview ??= new LocalPreview(validatePreview(previewSettings), openPreview, (text) => {
        if (session === connection) {
          emit({ kind: 'dev', text })
        }
      })
      await preview.open()
    } finally {
      previewing = false
    }
  }

  async function openTerminal(input) {
    const current = session
    if (!current || current.terminalId !== input?.terminalId) {
      throw new Error('Connect a workspace before opening the remote terminal.')
    }
    await current.openTerminal(input, (event) => {
      if (session === current) {
        emit({ ...event, terminalId: current.terminalId })
      }
    })
  }

  return {
    connect,
    openTerminal,
    terminalWrite(input) {
      if (session && session.terminalId === input?.terminalId) {
        session.terminal.write(input.data)
      }
    },
    terminalResize(input) {
      if (session && session.terminalId === input?.terminalId) {
        session.terminal.resize(input)
      }
    },
    terminalAck(input) {
      if (session && session.terminalId === input?.terminalId) {
        session.terminal.ack(input.chars)
      }
    },
    preview: startPreview,
    disconnect
  }
}
