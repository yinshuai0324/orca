import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import type {
  LanWorkspaceAgent,
  LanWorkspaceConnection,
  LanWorkspaceMount
} from '../../../../../shared/remote-runtime/lan-workspace/lan-workspace-api'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { readIpcErrorDetail } from '@/runtime/errors/ipc-error'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DialogCancel, DialogDisclosure, DialogError } from '@/components/ui/dialog-parts'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { LanWorkspaceConnectionFields } from './LanWorkspaceConnectionFields'

const preferencesKey = 'orca-lan-project'
const defaultPreferences = {
  host: '',
  username: '',
  directory: '',
  startCommand: 'npm run dev',
  previewUrl: 'http://127.0.0.1:5173/'
}

function isSavedPreferences(
  value: unknown
): value is Partial<Record<keyof typeof defaultPreferences, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readConnectionDraft(): LanWorkspaceConnection {
  const draft = { ...defaultPreferences, password: '' }
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(preferencesKey) ?? 'null')
    if (isSavedPreferences(saved)) {
      const fields: (keyof typeof defaultPreferences)[] = [
        'host',
        'username',
        'directory',
        'startCommand',
        'previewUrl'
      ]
      for (const field of fields) {
        const value = saved[field]
        if (typeof value === 'string') {
          draft[field] = value
        }
      }
    }
  } catch {
    // The form remains available when profile storage is unavailable.
  }
  return draft
}

function rememberConnection({ password: _password, ...preferences }: LanWorkspaceConnection): void {
  try {
    localStorage.setItem(preferencesKey, JSON.stringify(preferences))
  } catch {
    // Storage failure should not affect the SSH connection.
  }
}

type Activity = 'connecting' | 'disconnecting' | 'running' | 'previewing'
type Message = { id: number; author: 'user' | LanWorkspaceAgent; text: string }

export default function LanWorkspaceDialog(): React.JSX.Element | null {
  const t = useTranslate()
  const api = window.api.lanWorkspace
  const closeModal = useAppStore((state) => state.closeModal)
  const [draft, setDraft] = useState(readConnectionDraft)
  const [mount, setMount] = useState<LanWorkspaceMount | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<LanWorkspaceAgent>('codex')
  const agent = mount?.agents.find((entry) => entry === selectedAgent) ?? mount?.agents[0]
  const [activity, setActivity] = useState<Activity | null>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<'disconnected' | 'preview-ready' | null>(null)
  const [prompt, setPrompt] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [logs, setLogs] = useState('')
  const nextMessageId = useRef(0)
  const appendMessage = useCallback((author: Message['author'], text: string) => {
    nextMessageId.current += 1
    const message = { id: nextMessageId.current, author, text }
    setMessages((previous) => [...previous, message])
  }, [])
  const logRef = useRef<HTMLDivElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const busy = activity !== null

  useEffect(() => {
    if (!api) {
      return
    }
    const unsubscribe = api.onMessage((message) => {
      switch (message.kind) {
        case 'disconnected':
          setMount(null)
          setStatus('disconnected')
          break
        case 'previewing':
          // The progress broadcast can arrive after a fast preview has already completed.
          setActivity((current) => (current === 'running' ? 'previewing' : current))
          break
        case 'assistant':
          appendMessage(message.agent, message.text)
          break
        case 'dev':
          setLogs((previous) => (previous + message.text).slice(-48_000))
          break
      }
    })
    return () => {
      unsubscribe()
      void api.disconnect().catch(() => {})
    }
  }, [api, appendMessage])

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [messages])

  useEffect(() => {
    if (agent && !busy) {
      promptRef.current?.focus()
    }
  }, [agent, busy])

  if (!api) {
    return null
  }

  const setField = (field: keyof LanWorkspaceConnection, value: string): void =>
    setDraft((previous) => ({ ...previous, [field]: value }))

  const showError = (failure: unknown): void =>
    setError(readIpcErrorDetail(failure) ?? String(failure))

  const connect = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy || mount) {
      return
    }
    setActivity('connecting')
    setError('')
    setStatus(null)
    try {
      const input = { ...draft, host: draft.host.trim(), username: draft.username.trim() }
      const mounted = await api.connect(input)
      rememberConnection(input)
      setField('password', '')
      setMessages([])
      setLogs('')
      setPrompt('')
      setMount(mounted)
    } catch (failure) {
      showError(failure)
    }
    setActivity(null)
  }

  const disconnect = async (): Promise<void> => {
    setActivity('disconnecting')
    setError('')
    try {
      await api.disconnect()
      setMount(null)
      setStatus('disconnected')
    } catch (failure) {
      showError(failure)
    }
    setActivity(null)
  }

  const sendTask = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const text = prompt.trim()
    if (busy || !mount || !agent || !text) {
      return
    }
    setActivity('running')
    setStatus(null)
    setError('')
    appendMessage('user', text)
    setPrompt('')
    try {
      await api.turn({ agent, prompt: text })
      setStatus('preview-ready')
    } catch (failure) {
      showError(failure)
    }
    setActivity(null)
  }

  const agentLabels = {
    codex: t('lanWorkspace.codex', 'Codex'),
    claude: t('lanWorkspace.claude', 'Claude Code')
  }
  const activityLabels = {
    connecting: t('lanWorkspace.connecting', 'Connecting and mounting…'),
    disconnecting: t('lanWorkspace.disconnecting', 'Disconnecting…'),
    running: t('lanWorkspace.running', 'The remote AI CLI is working…'),
    previewing: t('lanWorkspace.previewing', 'Waiting for the Mac development server…')
  }
  const statusLabels = {
    disconnected: t('lanWorkspace.disconnected', 'SSH disconnected'),
    'preview-ready': t('lanWorkspace.previewReady', 'Mac preview is ready')
  }
  const statusText = activity ? activityLabels[activity] : status && statusLabels[status]

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && closeModal()}>
      <DialogContent
        size="form"
        surface="security"
        scrollable
        busy={busy}
        showCloseButton
        className="sm:max-w-xl"
        onInteractOutside={(event) => {
          if (mount || draft.password) {
            event.preventDefault()
          }
        }}
      >
        <DialogHeader className="mr-6">
          <DialogTitle>{t('lanWorkspace.addHost', 'Add Remote Local Host')}</DialogTitle>
          <DialogDescription>
            {t(
              'lanWorkspace.description',
              'Run an AI CLI on a remote Mac or Linux host and preview its changes on this Mac.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={mount ? sendTask : connect}>
          {mount ? (
            <>
              <p className="min-w-0 text-sm break-words text-muted-foreground">
                {t('lanWorkspace.mountedAt', 'Mounted at {{path}}', { path: mount.path })}
              </p>
              {messages.length > 0 ? (
                <div
                  ref={logRef}
                  role="log"
                  aria-label={t('lanWorkspace.conversation', 'Remote AI conversation')}
                  className="grid max-h-48 gap-3 overflow-y-auto scrollbar-sleek rounded-md border border-border p-3 text-sm"
                >
                  {messages.map(({ id, author, text }) => (
                    <div key={id} className="min-w-0">
                      <div className="mb-1 text-xs font-medium text-muted-foreground">
                        {author === 'user' ? t('lanWorkspace.you', 'You') : agentLabels[author]}
                      </div>
                      <p className="whitespace-pre-wrap break-words">{text}</p>
                    </div>
                  ))}
                </div>
              ) : null}
              <DialogDisclosure label={t('lanWorkspace.devLog', 'Mac development server log')}>
                <pre className="max-h-36 overflow-auto scrollbar-sleek font-mono text-xs whitespace-pre-wrap">
                  {logs || t('lanWorkspace.logEmpty', 'Waiting for output…')}
                </pre>
              </DialogDisclosure>
              {agent ? (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="lan-workspace-agent">
                      {t('lanWorkspace.agent', 'Remote AI CLI')}
                    </Label>
                    <Select
                      value={agent}
                      onValueChange={(value) => {
                        const next = mount.agents.find((entry) => entry === value)
                        if (next) {
                          setSelectedAgent(next)
                        }
                      }}
                      disabled={busy || mount.agents.length === 1}
                    >
                      <SelectTrigger id="lan-workspace-agent">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent position="popper">
                        {mount.agents.map((entry) => (
                          <SelectItem key={entry} value={entry}>
                            {agentLabels[entry]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="lan-workspace-prompt">
                      {t('lanWorkspace.task', 'Task for the remote AI')}
                    </Label>
                    <Textarea
                      id="lan-workspace-prompt"
                      ref={promptRef}
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      rows={3}
                      maxLength={32_000}
                      disabled={busy}
                      required
                    />
                  </div>
                </>
              ) : (
                <p role="status" className="text-sm text-muted-foreground">
                  {t(
                    'lanWorkspace.noAgent',
                    'The project is mounted. This SSH session could not find Codex CLI or Claude Code. Make either CLI available on the remote host, then reconnect.'
                  )}
                </p>
              )}
            </>
          ) : (
            <LanWorkspaceConnectionFields
              draft={draft}
              busy={busy}
              onChange={setField}
              onBrowse={() => {
                void api.chooseDirectory().then((path) => {
                  if (path) {
                    setField('directory', path)
                  }
                }, showError)
              }}
            />
          )}
          {statusText && (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              {busy && <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />}
              {statusText}
            </p>
          )}
          {error && <DialogError>{error}</DialogError>}
          <DialogFooter>
            {mount ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void disconnect()}
              >
                {t('lanWorkspace.disconnect', 'Disconnect')}
              </Button>
            ) : (
              <DialogCancel />
            )}
            {!mount || agent ? (
              <Button type="submit" size="sm" disabled={busy || Boolean(mount && !prompt.trim())}>
                {mount
                  ? t('lanWorkspace.send', 'Send and preview')
                  : t('lanWorkspace.connect', 'Connect and mount')}
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
