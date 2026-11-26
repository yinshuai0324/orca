const api = window.lanWorkspace
const connection = document.querySelector('#connection')
const settings = document.querySelector('#settings')
const connectButton = document.querySelector('#connect')
const disconnectButton = document.querySelector('#disconnect')
const status = document.querySelector('#status')
const mount = document.querySelector('#mount')
const messages = document.querySelector('#messages')
const logs = document.querySelector('#logs')
const error = document.querySelector('#error')
const task = document.querySelector('#task')
const prompt = document.querySelector('#prompt')
const sendButton = document.querySelector('#send')
let connected = false
let busy = false

const settingsKey = 'orca-lan-project'
const savedFields = ['host', 'username', 'directory', 'startCommand', 'previewUrl']
try {
  const saved = JSON.parse(localStorage.getItem(settingsKey) ?? '{}')
  for (const name of savedFields) {
    if (typeof saved[name] === 'string') {
      connection.elements[name].value = saved[name]
    }
  }
} catch {
  // Leave the defaults when profile storage is unavailable.
}

function updateControls() {
  settings.disabled = busy || connected
  connectButton.disabled = busy || connected
  disconnectButton.disabled = busy || !connected
  prompt.disabled = busy || !connected
  sendButton.disabled = busy || !connected
}

function displayError(message) {
  error.textContent = message
  error.hidden = !message
}

function addMessage(text, author) {
  const row = document.createElement('p')
  row.textContent = `${author} · ${text}`
  messages.append(row)
  messages.scrollTop = messages.scrollHeight
}

document.querySelector('#choose').addEventListener('click', async () => {
  const directory = await api.chooseDirectory()
  if (directory) {
    document.querySelector('#directory').value = directory
  }
})

connection.addEventListener('submit', async (event) => {
  event.preventDefault()
  const input = Object.fromEntries(new FormData(connection))
  busy = true
  displayError('')
  updateControls()
  try {
    const path = await api.connect(input)
    connected = true
    try {
      localStorage.setItem(
        settingsKey,
        JSON.stringify(Object.fromEntries(savedFields.map((name) => [name, input[name]])))
      )
    } catch {
      // The connection is still usable when profile storage is unavailable.
    }
    mount.textContent = path
    connection.elements.password.value = ''
    status.textContent = '已挂载'
  } catch (failure) {
    status.textContent = '连接失败'
    displayError(failure.message)
  } finally {
    busy = false
    updateControls()
    if (connected) {
      prompt.focus()
    }
  }
})

disconnectButton.addEventListener('click', async () => {
  busy = true
  updateControls()
  await api.disconnect()
  connected = false
  busy = false
  mount.textContent = ''
  status.textContent = '已断开'
  updateControls()
})

task.addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = prompt.value.trim()
  if (!text) {
    return
  }
  busy = true
  displayError('')
  addMessage(text, '你')
  prompt.value = ''
  status.textContent = '远程 Codex 处理中…'
  updateControls()
  try {
    await api.turn(text)
  } catch (failure) {
    status.textContent = '任务或预览失败'
    displayError(failure.message)
  } finally {
    busy = false
    updateControls()
    if (connected) {
      prompt.focus()
    }
  }
})

api.onMessage(({ kind, text }) => {
  if (kind === 'status' || kind === 'disconnected') {
    status.textContent = text
  }
  if (kind === 'disconnected') {
    connected = false
    mount.textContent = ''
    updateControls()
  }
  if (kind === 'assistant') {
    addMessage(text, 'Codex')
  }
  if (kind === 'dev') {
    logs.textContent = (logs.textContent + text).slice(-48_000)
  }
})
