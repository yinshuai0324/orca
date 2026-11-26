import { join } from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { LanSession, validateProject } from './lan-session.mjs'
import { LocalPreview } from './local-preview.mjs'

const directory = import.meta.dirname
const background = process.env.ORCA_BACKGROUND_LAUNCH === '1'
const hostKeys = new Map()
let window
let session
let preview
let busy = false

function show(kind, text) {
  if (window && !window.isDestroyed()) {
    window.webContents.send('lan-workspace:message', { kind, text })
  }
}

async function disconnect() {
  const current = session
  session = undefined
  preview?.close()
  preview = undefined
  await current?.close()
}

function register(name, callback) {
  ipcMain.handle(`lan-workspace:${name}`, (event, value) => {
    if (
      event.sender !== window?.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    ) {
      throw new Error('This action belongs to the workspace window.')
    }
    return callback(value)
  })
}

register('choose-directory', async () => {
  const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
  return result.filePaths[0] ?? null
})

register('connect', async (input) => {
  if (busy || session) {
    throw new Error('Disconnect the current workspace first.')
  }
  busy = true
  try {
    const project = await validateProject(input)
    show('status', '正在 SSH 连接并挂载项目…')
    const connection = new LanSession({
      verifyHost: async (host, fingerprint) => {
        const previous = hostKeys.get(host)
        if (previous) {
          return previous === fingerprint
        }
        const answer = await dialog.showMessageBox(window, {
          type: 'warning',
          message: '确认远程 SSH 主机指纹',
          detail: `${host}\n${fingerprint}`,
          buttons: ['取消', '信任并连接'],
          defaultId: 0,
          cancelId: 0
        })
        if (answer.response === 1) {
          hostKeys.set(host, fingerprint)
          return true
        }
        return false
      },
      onDisconnect: () => {
        if (session === connection) {
          void disconnect()
          show('disconnected', 'SSH 已断开')
        }
      }
    })
    session = connection
    const mount = await connection.open(input, project.directory)
    if (session !== connection) {
      throw new Error('SSH connection closed.')
    }
    preview = new LocalPreview(
      project,
      (url) => (background ? Promise.resolve() : shell.openExternal(url)),
      (line) => show('dev', line)
    )
    return mount
  } catch (error) {
    await disconnect()
    throw error
  } finally {
    busy = false
  }
})

register('turn', async (prompt) => {
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
    await runningSession.runTurn(prompt, (message) => show('assistant', message))
    show('status', '远程任务完成，正在等待 Mac 开发服务…')
    if (session !== runningSession) {
      throw new Error('SSH connection closed.')
    }
    await runningPreview.open()
    show('status', background ? 'Mac 预览已就绪' : '已打开 Mac 浏览器')
  } finally {
    busy = false
  }
})

register('disconnect', async () => {
  await disconnect()
})

export async function openLanWorkspaceWindow() {
  if (window && !window.isDestroyed()) {
    if (!background) {
      window.focus()
    }
    return
  }

  const workspace = new BrowserWindow({
    width: 820,
    height: 765,
    minWidth: 590,
    minHeight: 560,
    show: !background,
    title: 'Orca · 局域网开发',
    webPreferences: {
      preload: join(directory, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  window = workspace
  workspace.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  workspace.webContents.on('will-navigate', (event) => event.preventDefault())
  workspace.once('closed', () => {
    window = undefined
    void disconnect()
  })
  try {
    await workspace.loadFile(join(directory, 'workspace.html'))
  } catch (error) {
    if (!workspace.isDestroyed()) {
      workspace.close()
    }
    throw error
  }
}
