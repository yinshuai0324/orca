import { useEffect, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import type {
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
import { LanWorkspaceConnectionFields } from './LanWorkspaceConnectionFields'
import { LanWorkspaceTerminal } from './LanWorkspaceTerminal'

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

type Activity = 'connecting' | 'disconnecting' | 'previewing'

export default function LanWorkspaceDialog(): React.JSX.Element | null {
  const t = useTranslate()
  const api = window.api.lanWorkspace
  const closeModal = useAppStore((state) => state.closeModal)
  const [draft, setDraft] = useState(readConnectionDraft)
  const [mount, setMount] = useState<LanWorkspaceMount | null>(null)
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
        setMount(null)
        setStatus('disconnected')
      } else if (message.kind === 'dev') {
        setLogs((previous) => (previous + message.text).slice(-48_000))
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
      setLogs('')
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

  const startPreview = async (): Promise<void> => {
    if (busy || !mount) {
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
    disconnecting: t('lanWorkspace.disconnecting', 'Disconnecting…'),
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
        className={mount ? 'sm:max-w-4xl' : 'sm:max-w-xl'}
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
              'Mount a Mac project on a remote host and open a terminal in the mounted folder.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={connect}>
          {mount ? (
            <>
              <p className="min-w-0 text-sm break-words text-muted-foreground">
                {t('lanWorkspace.mountedAt', 'Mounted at {{path}}', { path: mount.path })}
              </p>
              <LanWorkspaceTerminal
                key={mount.terminalId}
                api={api}
                terminalId={mount.terminalId}
              />
              <DialogDisclosure label={t('lanWorkspace.devLog', 'Mac development server log')}>
                <pre className="max-h-36 overflow-auto scrollbar-sleek font-mono text-xs whitespace-pre-wrap">
                  {logs || t('lanWorkspace.logEmpty', 'Waiting for output…')}
                </pre>
              </DialogDisclosure>
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
            {mount ? (
              <Button type="button" size="sm" disabled={busy} onClick={() => void startPreview()}>
                {t('lanWorkspace.startPreview', 'Start and preview on this Mac')}
              </Button>
            ) : (
              <Button type="submit" size="sm" disabled={busy}>
                {t('lanWorkspace.connect', 'Connect and mount')}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
