import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import type { LanWorkspaceConnection } from '../../../../../shared/remote-runtime/lan-workspace/lan-workspace-api'
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
type Message = { id: number; author: 'user' | 'assistant'; text: string }

export default function LanWorkspaceDialog(): React.JSX.Element | null {
  const t = useTranslate()
  const api = window.api.lanWorkspace
  const closeModal = useAppStore((state) => state.closeModal)
  const [draft, setDraft] = useState(readConnectionDraft)
  const [mount, setMount] = useState<string | null>(null)
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
          setActivity('previewing')
          break
        case 'assistant':
          appendMessage('assistant', message.text)
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
    if (mount && !busy) {
      promptRef.current?.focus()
    }
  }, [mount, busy])

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
      const path = await api.connect(input)
      rememberConnection(input)
      setField('password', '')
      setMessages([])
      setLogs('')
      setPrompt('')
      setMount(path)
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
    if (busy || !mount || !text) {
      return
    }
    setActivity('running')
    setStatus(null)
    setError('')
    appendMessage('user', text)
    setPrompt('')
    try {
      await api.turn(text)
      setStatus('preview-ready')
    } catch (failure) {
      showError(failure)
    }
    setActivity(null)
  }

  const activityLabels = {
    connecting: t('lanWorkspace.connecting', 'Connecting and mounting…'),
    disconnecting: t('lanWorkspace.disconnecting', 'Disconnecting…'),
    running: t('lanWorkspace.running', 'Remote Codex is working…'),
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
              'Connect to Codex on a Linux host and preview its changes on your Mac.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={mount ? sendTask : connect}>
          {mount ? (
            <>
              <p className="min-w-0 text-sm break-words text-muted-foreground">
                {t('lanWorkspace.mountedAt', 'Mounted at {{path}}', { path: mount })}
              </p>
              {messages.length > 0 ? (
                <div
                  ref={logRef}
                  role="log"
                  aria-label={t('lanWorkspace.conversation', 'Remote Codex conversation')}
                  className="grid max-h-48 gap-3 overflow-y-auto scrollbar-sleek rounded-md border border-border p-3 text-sm"
                >
                  {messages.map(({ id, author, text }) => (
                    <div key={id} className="min-w-0">
                      <div className="mb-1 text-xs font-medium text-muted-foreground">
                        {author === 'user'
                          ? t('lanWorkspace.you', 'You')
                          : t('lanWorkspace.codex', 'Codex')}
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
              <div className="grid gap-2">
                <Label htmlFor="lan-workspace-prompt">
                  {t('lanWorkspace.task', 'Task for remote Codex')}
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
            <Button type="submit" size="sm" disabled={busy || Boolean(mount && !prompt.trim())}>
              {mount
                ? t('lanWorkspace.send', 'Send and preview')
                : t('lanWorkspace.connect', 'Connect and mount')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
