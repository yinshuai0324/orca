// @protected-copy
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import type { Client } from 'ssh2'
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
import { isSshHostMoveBlocked } from '../../../shared/remote-runtime/ssh/ssh-host-move-blocked'
import { clearSshCredentialDeclined } from '../../ssh/authentication/ssh-credential-decline'
import { SshConnection } from '../../ssh/connection/ssh-connection'
import { getSshHostServerStatus } from '../../ssh/host-server/ssh-host-server-status'
import { fingerprintRuntimeSshTarget } from '../../ssh/runtime-access/runtime-ssh-target-fingerprint'
import {
  getSshConnectionManager,
  getSshTargetRegistryStore
} from '../../ssh/targets/ssh-target-registry'
import { isRuntimeOwnedSshTarget } from '../../ssh/targets/ssh-target-runtime-ownership'
import { isBackgroundLaunch } from '../../window/activation/foreground-activation-policy'
import { assertSshConnectsNotFenced } from '../ssh/ssh-connect-attempt-registry'
import { requestCredential } from '../ssh/ssh-passphrase'
import { awaitSshStartupReady } from '../ssh/ssh-startup-ready'
import { awaitTargetLifecycle } from '../ssh/ssh-target-lifecycle-queue'
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
    openSshTransport(targetId: string, signal: AbortSignal): Promise<SshTransport>
    openPreview(url: string): Promise<void>
    emit(message: LanWorkspaceMessage): void
  }): LanWorkspaceController
}

type SshTransport = { client: Client; release?: () => Promise<void> }

async function openSavedSshTransport(targetId: string, signal: AbortSignal): Promise<SshTransport> {
  await awaitSshStartupReady()
  await awaitTargetLifecycle(targetId)
  signal.throwIfAborted()
  assertSshConnectsNotFenced()
  const manager = getSshConnectionManager()
  const store = getSshTargetRegistryStore()
  const target = store?.getTarget(targetId)
  if (!manager || !target || isRuntimeOwnedSshTarget(target)) {
    throw new Error(
      translateMain('lanWorkspace.savedHostMissing', 'Choose a saved SSH host in Settings.')
    )
  }
  if (isSshHostMoveBlocked(getSshHostServerStatus(targetId))) {
    throw new Error(
      translateMain('lanWorkspace.hostMoving', 'Wait for the SSH host move to finish.')
    )
  }
  const existing = manager.getConnection(targetId)
  const borrowed =
    existing?.getState().status === 'connected' && !existing.isDisposed() ? existing : undefined
  // A mount-only connection must stay out of workspace restore, which can provision a remote server.
  const connection =
    borrowed ??
    new SshConnection(target, {
      onStateChange: () => {},
      onCredentialRequest: requestCredential
    })
  let releasing: Promise<void> | undefined
  const release = borrowed
    ? undefined
    : () => (releasing ??= connection.disconnect({ quiet: true }))
  const abort = (): void => {
    void release?.().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (!borrowed) {
      clearSshCredentialDeclined(targetId)
      await connection.connect()
    }
    signal.throwIfAborted()
    const currentTarget = store?.getTarget(targetId)
    if (
      !currentTarget ||
      fingerprintRuntimeSshTarget(currentTarget) !==
        fingerprintRuntimeSshTarget(connection.getTarget())
    ) {
      throw new Error(
        translateMain(
          'lanWorkspace.hostChanged',
          'The SSH settings changed. Disconnect the host and try again.'
        )
      )
    }
    const client = connection.getClient()
    if (!client) {
      throw new Error(
        translateMain(
          'lanWorkspace.directSshRequired',
          'Mounting requires an SSH transport that supports session channels and reverse forwarding.'
        )
      )
    }
    return { client, release }
  } catch (error) {
    await release?.().catch(() => {})
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
  }
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

  ipcMain.handle(channels.available, (event) => trustedWindow(event) !== null)
  ipcMain.handle(channels.chooseDirectory, async (event) => {
    const result = await dialog.showOpenDialog(requireWindow(event), {
      properties: ['openDirectory']
    })
    return result.filePaths[0] ?? null
  })
  ipcMain.handle(channels.connect, async (event, input: LanWorkspaceConnectInput) => {
    const owner = requireWindow(event)
    if (
      typeof input?.targetId !== 'string' ||
      !input.targetId ||
      (input.mode !== 'mount' && input.mode !== 'terminal')
    ) {
      throw new Error(
        translateMain('lanWorkspace.savedHostMissing', 'Choose a saved SSH host in Settings.')
      )
    }
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
          openSshTransport: openSavedSshTransport,
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
