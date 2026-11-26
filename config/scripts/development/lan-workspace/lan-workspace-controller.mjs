import { LanSession, validateProject } from './lan-session.mjs'
import { LocalPreview } from './local-preview.mjs'

export function createLanWorkspaceController({ verifyHost, openPreview, emit }) {
  let session
  let preview
  let busy = false
  let generation = 0

  async function disconnect() {
    generation += 1
    const current = session
    session = undefined
    preview?.close()
    preview = undefined
    await current?.close()
  }

  async function connect(input) {
    if (busy || session) {
      throw new Error('Disconnect the current workspace first.')
    }
    busy = true
    const connecting = generation
    try {
      const project = await validateProject(input)
      if (generation !== connecting) {
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
      const mount = await connection.open(input, project.directory)
      if (session !== connection) {
        throw new Error('SSH connection closed.')
      }
      preview = new LocalPreview(project, openPreview, (text) => {
        if (session === connection) {
          emit({ kind: 'dev', text })
        }
      })
      return mount
    } catch (error) {
      await disconnect()
      throw error
    } finally {
      busy = false
    }
  }

  async function turn(prompt) {
    if (
      busy ||
      !session ||
      !preview ||
      typeof prompt !== 'string' ||
      !prompt.trim() ||
      prompt.length > 32_000
    ) {
      throw new Error('Connect a workspace and enter a task of up to 32,000 characters.')
    }
    busy = true
    const runningSession = session
    const runningPreview = preview
    try {
      await runningSession.runTurn(prompt, (text) => {
        if (session === runningSession) {
          emit({ kind: 'assistant', text })
        }
      })
      if (session !== runningSession) {
        throw new Error('SSH connection closed.')
      }
      emit({ kind: 'previewing' })
      await runningPreview.open()
    } finally {
      busy = false
    }
  }

  return { connect, turn, disconnect }
}
