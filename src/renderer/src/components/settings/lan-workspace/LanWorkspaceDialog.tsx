import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { LanWorkspaceSessionInfo } from '../../../../../shared/remote-runtime/lan-workspace/lan-workspace-api'
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
import { LanWorkspaceTerminal } from './LanWorkspaceTerminal'

type Activity = 'connecting' | 'disconnecting' | 'previewing'

export default function LanWorkspaceDialog({
  targetId,
  targetLabel
}: {
  targetId: string
  targetLabel: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const api = window.api.lanWorkspace
  const closeModal = useAppStore((state) => state.closeModal)
  const [connection, setConnection] = useState<LanWorkspaceSessionInfo | null>(null)
  const [activity, setActivity] = useState<Activity | null>('connecting')
  const [error, setError] = useState('')
  const [status, setStatus] = useState<'disconnected' | 'preview-ready' | null>(null)
  const [logs, setLogs] = useState('')
  const busy = activity !== null

  const connect = useCallback(async () => {
    if (!api) {
      return
    }
    setActivity('connecting')
    setError('')
    setStatus(null)
    setLogs('')
    try {
      setConnection(await api.connect({ targetId }))
    } catch (failure) {
      setError(readIpcErrorDetail(failure) ?? String(failure))
    }
    setActivity(null)
  }, [api, targetId])

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
    let cancelled = false
    void Promise.resolve().then(() => {
      if (!cancelled) {
        void connect()
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
      void api.disconnect().catch(() => {})
    }
  }, [api, connect])

  if (!api) {
    return null
  }

  const disconnect = async (): Promise<void> => {
    setActivity('disconnecting')
    setError('')
    try {
      await api.disconnect()
      closeModal()
    } catch (failure) {
      setError(readIpcErrorDetail(failure) ?? String(failure))
      setActivity(null)
    }
  }

  const startPreview = async (): Promise<void> => {
    setActivity('previewing')
    setStatus(null)
    setError('')
    try {
      await api.preview()
      setStatus('preview-ready')
    } catch (failure) {
      setError(readIpcErrorDetail(failure) ?? String(failure))
    }
    setActivity(null)
  }

  const activityLabels = {
    connecting: t('lanWorkspace.connecting', 'Connecting and mounting…'),
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
          <DialogTitle>{targetLabel}</DialogTitle>
          <DialogDescription>
            {connection
              ? t('lanWorkspace.mountedAt', 'Mounted at {{path}}', { path: connection.path })
              : t(
                  'lanWorkspace.mountOnHost',
                  'Mount a project from this Mac on {{host}} and open a terminal in the mounted folder.',
                  { host: targetLabel }
                )}
          </DialogDescription>
        </DialogHeader>
        {connection ? (
          <>
            <LanWorkspaceTerminal
              key={connection.terminalId}
              api={api}
              terminalId={connection.terminalId}
            />
            <DialogDisclosure label={t('lanWorkspace.devLog', 'Mac development server log')}>
              <pre className="max-h-36 overflow-auto scrollbar-sleek font-mono text-xs whitespace-pre-wrap">
                {logs || t('lanWorkspace.logEmpty', 'Waiting for output…')}
              </pre>
            </DialogDisclosure>
          </>
        ) : null}
        {statusText ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            {busy && <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />}
            {statusText}
          </p>
        ) : null}
        {error ? <DialogError>{error}</DialogError> : null}
        <DialogFooter>
          {connection ? (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void disconnect()}>
                {t('lanWorkspace.unmount', 'Unmount project')}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void startPreview()}>
                {t('lanWorkspace.startPreview', 'Start and preview on this Mac')}
              </Button>
            </>
          ) : (
            <>
              <DialogCancel />
              {!busy ? (
                <Button size="sm" onClick={() => void connect()}>
                  {t('lanWorkspace.retryConnection', 'Retry connection')}
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
