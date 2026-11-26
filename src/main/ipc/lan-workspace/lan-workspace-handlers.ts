import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  LAN_WORKSPACE_CHANNELS,
  type LanWorkspaceConnectInput,
  type LanWorkspaceMessage,
  type LanWorkspaceSessionInfo,
  type LanWorkspaceTerminalSize,
  type LanWorkspaceApi
} from '../../../shared/remote-runtime/lan-workspace/lan-workspace-api'
import { translateMain } from '../../i18n/main-i18n'
import { isBackgroundLaunch } from '../../window/activation/foreground-activation-policy'
import { isTrustedUIRenderer } from '../ui'
import { translateLanWorkspacePrerequisiteError } from './lan-workspace-prerequisite-error'

type LanWorkspaceController = {
  connect(input: LanWorkspaceConnectInput): Promise<LanWorkspaceSessionInfo>
  openTerminal: LanWorkspaceApi['openTerminal']
  terminalWrite: LanWorkspaceApi['terminalWrite']
  terminalResize: LanWorkspaceApi['terminalResize']
  terminalAck: LanWorkspaceApi['terminalAck']
  preview(): Promise<void>
  disconnect(): Promise<void>
}

type LanWorkspaceModule = {
  createLanWorkspaceController(options: {
    verifyHost(host: string, fingerprint: string): Promise<boolean>
    openPreview(url: string): Promise<void>
    emit(message: LanWorkspaceMessage): void
  }): LanWorkspaceController
}

function trustedWindow(event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null {
  if (
    process.platform !== 'darwin' ||
    app.isPackaged ||
    !isTrustedUIRenderer(event.sender) ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    return null
  }
  return BrowserWindow.fromWebContents(event.sender)
}

function requireWindow(event: IpcMainInvokeEvent): BrowserWindow {
  const owner = trustedWindow(event)
  if (!owner) {
    throw new Error('LAN workspaces are available from the main Orca window on macOS.')
  }
  return owner
}

export function registerLanWorkspaceHandlers(): void {
  const channels = LAN_WORKSPACE_CHANNELS
  const controllers = new WeakMap<BrowserWindow, LanWorkspaceController>()
  const hostKeys = new Map<string, string>()

  ipcMain.handle(channels.available, (event) => trustedWindow(event) !== null)
  ipcMain.handle(channels.chooseDirectory, async (event) => {
    const result = await dialog.showOpenDialog(requireWindow(event), {
      properties: ['openDirectory']
    })
    return result.filePaths[0] ?? null
  })
  ipcMain.handle(channels.connect, async (event, input: LanWorkspaceConnectInput) => {
    const owner = requireWindow(event)
    let controller = controllers.get(owner)
    if (!controller) {
      const entry = pathToFileURL(
        join(
          process.env.ORCA_DEV_REPO_ROOT ?? app.getAppPath(),
          'config',
          'scripts',
          'development',
          'lan-workspace',
          'lan-workspace-controller.mjs'
        )
      ).href
      const source: LanWorkspaceModule = await import(/* @vite-ignore */ entry)
      requireWindow(event)
      controller = controllers.get(owner)
      if (!controller) {
        const sender = event.sender
        const session = source.createLanWorkspaceController({
          verifyHost: async (host, fingerprint) => {
            const previous = hostKeys.get(host)
            if (previous) {
              return previous === fingerprint
            }
            const answer = await dialog.showMessageBox(owner, {
              type: 'warning',
              message: translateMain(
                'lanWorkspace.confirmFingerprint',
                'Confirm SSH host fingerprint'
              ),
              detail: `${host}\n${fingerprint}`,
              buttons: [
                translateMain('lanWorkspace.cancel', 'Cancel'),
                translateMain('lanWorkspace.trustAndConnect', 'Trust and connect')
              ],
              defaultId: 0,
              cancelId: 0
            })
            if (answer.response !== 1 || owner.isDestroyed()) {
              return false
            }
            hostKeys.set(host, fingerprint)
            return true
          },
          openPreview: (url) =>
            isBackgroundLaunch() ? Promise.resolve() : shell.openExternal(url),
          emit: (message) => {
            if (!sender.isDestroyed()) {
              sender.send(channels.message, message)
            }
          }
        })
        const disconnect = (): void => {
          void session.disconnect()
        }
        sender.on('did-start-navigation', (details) => {
          if (details.isMainFrame && !details.isSameDocument) {
            disconnect()
          }
        })
        sender.on('render-process-gone', disconnect)
        sender.once('destroyed', disconnect)
        controllers.set(owner, session)
        controller = session
      }
    }
    return controller.connect(input).catch((error: unknown) => {
      throw translateLanWorkspacePrerequisiteError(error)
    })
  })
  const requireController = (event: IpcMainInvokeEvent): LanWorkspaceController => {
    const controller = controllers.get(requireWindow(event))
    if (!controller) {
      throw new Error('Connect and mount the project first.')
    }
    return controller
  }
  ipcMain.handle(channels.openTerminal, (event, input: LanWorkspaceTerminalSize) =>
    requireController(event).openTerminal(input)
  )
  ipcMain.handle(channels.preview, (event) => requireController(event).preview())
  for (const method of ['terminalWrite', 'terminalResize', 'terminalAck'] as const) {
    ipcMain.on(channels[method], (event, input) => {
      const owner = trustedWindow(event)
      if (owner) {
        controllers.get(owner)?.[method](input)
      }
    })
  }
  ipcMain.handle(channels.disconnect, async (event) => {
    await controllers.get(requireWindow(event))?.disconnect()
  })
}
