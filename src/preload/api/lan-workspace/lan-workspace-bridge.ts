import { ipcRenderer } from 'electron'
import {
  LAN_WORKSPACE_CHANNELS,
  type LanWorkspaceApi,
  type LanWorkspaceMessage
} from '../../../shared/remote-runtime/lan-workspace/lan-workspace-api'

const channels = LAN_WORKSPACE_CHANNELS

export const lanWorkspaceApi: LanWorkspaceApi = {
  available: () => ipcRenderer.invoke(channels.available),
  chooseDirectory: () => ipcRenderer.invoke(channels.chooseDirectory),
  connect: (input) => ipcRenderer.invoke(channels.connect, input),
  openTerminal: (input) => ipcRenderer.invoke(channels.openTerminal, input),
  terminalWrite: (input) => ipcRenderer.send(channels.terminalWrite, input),
  terminalResize: (input) => ipcRenderer.send(channels.terminalResize, input),
  terminalAck: (input) => ipcRenderer.send(channels.terminalAck, input),
  preview: () => ipcRenderer.invoke(channels.preview),
  disconnect: () => ipcRenderer.invoke(channels.disconnect),
  onMessage: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, message: LanWorkspaceMessage): void =>
      listener(message)
    ipcRenderer.on(channels.message, handler)
    return () => ipcRenderer.removeListener(channels.message, handler)
  }
}
