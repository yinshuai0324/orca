const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('lanWorkspace', {
  chooseDirectory: () => ipcRenderer.invoke('lan-workspace:choose-directory'),
  connect: (input) => ipcRenderer.invoke('lan-workspace:connect', input),
  turn: (prompt) => ipcRenderer.invoke('lan-workspace:turn', prompt),
  disconnect: () => ipcRenderer.invoke('lan-workspace:disconnect'),
  onMessage: (listener) => {
    ipcRenderer.on('lan-workspace:message', (_event, message) => listener(message))
  }
})
