import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type {
  LanWorkspaceConnectInput,
  LanWorkspaceProject,
  LanWorkspaceSessionInfo
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
import { LanWorkspaceConnectionFields } from './LanWorkspaceConnectionFields'
import { LanWorkspaceTerminal } from './LanWorkspaceTerminal'

const preferencesKey = 'orca-lan-project'
const defaultPreferences: LanWorkspaceProject = {
  directory: '',
  startCommand: 'npm run dev',
  previewUrl: 'http://127.0.0.1:5173/'
}

function isSavedPreferences(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readConnectionDraft(key: string, host?: string, username?: string): LanWorkspaceProject {
  const draft = { ...defaultPreferences }
  try {
    const stored = localStorage.getItem(key)
    const saved: unknown = JSON.parse(stored ?? localStorage.getItem(preferencesKey) ?? 'null')
    if (isSavedPreferences(saved)) {
      if (stored === null && (saved.host !== host || saved.username !== username)) {
        return draft
      }
      for (const field of ['directory', 'startCommand', 'previewUrl'] as const) {
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

function rememberConnection(key: string, preferences: LanWorkspaceProject): void {
  try {
    localStorage.setItem(key, JSON.stringify(preferences))
  } catch {
    // Storage failure should not affect the SSH connection.
  }
}

type Activity = 'connecting' | 'connecting-terminal' | 'disconnecting' | 'previewing'

export default function LanWorkspaceDialog({
  targetId,
  targetLabel,
  host,
  username
}: {
  targetId: string
  targetLabel: string
  host?: string
  username?: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const api = window.api.lanWorkspace
  const closeModal = useAppStore((state) => state.closeModal)
  const preferenceKey = `${preferencesKey}:${targetId}`
  const [draft, setDraft] = useState(() => readConnectionDraft(preferenceKey, host, username))
  const [connection, setConnection] = useState<LanWorkspaceSessionInfo | null>(null)
  const [activity, setActivity] = useState<Activity | null>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<'disconnected' | 'preview-ready' | null>(null)
  const [logs, setLogs] = useState('')
  const busy = activity !== null

  useEffect(() => {
    if (!api) {
      return
    }
    const unsubscribe = api.onMessage((message) => {
      if (message.kind === 'disconnected') {
        setConnection(null)
        setStatus('disconnected')
        setActivity((current) => (current === 'previewing' ? null : current))
      } else if (message.kind === 'dev') {
        setLogs((previous) => (previous + message.text).slice(-48_000))
      } else if (message.kind === 'preview') {
        if (message.state === 'starting') {
          setActivity('previewing')
          setError('')
        } else {
          setActivity((current) => (current === 'previewing' ? null : current))
          if (message.state === 'failed') {
            setError(message.detail)
          } else {
            setStatus('preview-ready')
          }
        }
      }
    })
    return () => {
      unsubscribe()
      void api.disconnect().catch(() => {})
    }
  }, [api])

  if (!api) {
    return null
  }

  const setField = (field: keyof LanWorkspaceProject, value: string): void =>
    setDraft((previous) => ({ ...previous, [field]: value }))

  const showError = (failure: unknown): void =>
    setError(readIpcErrorDetail(failure) ?? String(failure))

  const connect = async (mode: LanWorkspaceConnectInput['mode']): Promise<void> => {
    if (busy || connection) {
      return
    }
    setActivity(mode === 'mount' ? 'connecting' : 'connecting-terminal')
    setError('')
    setStatus(null)
    try {
      const connected = await api.connect({ ...draft, targetId, mode })
      if (mode === 'mount') {
        rememberConnection(preferenceKey, draft)
      }
      setLogs('')
      setConnection(connected)
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
      setConnection(null)
      setStatus('disconnected')
    } catch (failure) {
      showError(failure)
    }
    setActivity(null)
  }

  const startPreview = async (): Promise<void> => {
    if (busy || !connection?.path) {
      return
    }
    setActivity('previewing')
    setStatus(null)
    setError('')
    try {
      await api.preview()
      setStatus('preview-ready')
    } catch (failure) {
      showError(failure)
    }
    setActivity(null)
  }

  const activityLabels = {
    connecting: t('lanWorkspace.connecting', 'Connecting and mounting…'),
    'connecting-terminal': t('lanWorkspace.connectingTerminal', 'Connecting over SSH…'),
    disconnecting: t('lanWorkspace.disconnecting', 'Disconnecting…'),
    previewing: t('lanWorkspace.previewing', 'Waiting for the Mac development server…')
  }
  const statusLabels = {
    disconnected: t('lanWorkspace.sessionClosed', 'Session closed'),
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
        className={connection ? 'sm:max-w-4xl' : 'sm:max-w-xl'}
        onInteractOutside={(event) => {
          if (connection) {
            event.preventDefault()
          }
        }}
      >
        <DialogHeader className="mr-6">
          <DialogTitle>{t('lanWorkspace.mountLocalProject', 'Mount local project')}</DialogTitle>
          <DialogDescription>
            {t(
              'lanWorkspace.mountOnHost',
              'Mount a project from this Mac on {{host}} and open a terminal in the mounted folder.',
              { host: targetLabel }
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void connect('mount')
          }}
        >
          {connection ? (
            <>
              <p className="min-w-0 text-sm break-words text-muted-foreground">
                {connection.path
                  ? t('lanWorkspace.mountedAt', 'Mounted at {{path}}', { path: connection.path })
                  : t('lanWorkspace.homeTerminal', 'Connected to the remote home directory.')}
              </p>
              <LanWorkspaceTerminal
                key={connection.terminalId}
                api={api}
                terminalId={connection.terminalId}
              />
              {connection.path ? (
                <DialogDisclosure label={t('lanWorkspace.devLog', 'Mac development server log')}>
                  <pre className="max-h-36 overflow-auto scrollbar-sleek font-mono text-xs whitespace-pre-wrap">
                    {logs || t('lanWorkspace.logEmpty', 'Waiting for output…')}
                  </pre>
                </DialogDisclosure>
              ) : null}
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
            {connection ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void disconnect()}
                >
                  {connection.path
                    ? t('lanWorkspace.unmount', 'Unmount project')
                    : t('lanWorkspace.closeTerminal', 'Close terminal')}
                </Button>
                {connection.path ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    onClick={() => void startPreview()}
                  >
                    {t('lanWorkspace.startPreview', 'Start and preview on this Mac')}
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                <DialogCancel />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void connect('terminal')}
                >
                  {t('lanWorkspace.terminalOnly', 'Open terminal only')}
                </Button>
                <Button type="submit" size="sm" disabled={busy}>
                  {t('lanWorkspace.connect', 'Connect and mount')}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
