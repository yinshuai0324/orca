import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import type { LanWorkspaceApi } from '../../../../../shared/remote-runtime/lan-workspace/lan-workspace-api'
import { TerminalKittyKeyboardModeTracker } from '../../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-mode-tracker'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { translate } from '@/i18n/i18n'
import { effectiveMacOptionAsAlt } from '@/lib/keyboard-layout/detect-option-as-alt'
import { getOptionAsAltProbe } from '@/lib/keyboard-layout/option-as-alt-probe'
import { readIpcErrorDetail } from '@/runtime/errors/ipc-error'
import { composeActiveTerminalTheme } from '@/components/terminal-pane/appearance/terminal-appearance'
import { resolveEffectiveTerminalAppearance } from '@/lib/terminal/appearance/terminal-theme'
import { buildPreviewTerminalOptions } from '@/components/standalone-terminal/rendering/preview-terminal-options'
import { openStandaloneTerminal } from '@/components/standalone-terminal/open-standalone-terminal'
import { DialogError } from '@/components/ui/dialog-parts'

type TerminalPhase = { kind: 'opening' | 'ready' | 'ended' } | { kind: 'failed'; detail: string }

export function LanWorkspaceTerminal({
  api,
  terminalId
}: {
  api: LanWorkspaceApi
  terminalId: string
}): React.JSX.Element {
  const t = useTranslate()
  const containerRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<TerminalPhase>({ kind: 'opening' })

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const getSettings = () => useAppStore.getState().settings
    const settings = getSettings()
    const appearance = settings
      ? resolveEffectiveTerminalAppearance(
          settings,
          window.matchMedia('(prefers-color-scheme: dark)').matches
        )
      : null
    const theme =
      appearance && settings ? composeActiveTerminalTheme(appearance.theme, settings) : null
    const getMacOptionAsAlt = () =>
      effectiveMacOptionAsAlt(
        getSettings()?.terminalMacOptionAsAlt ?? 'auto',
        getOptionAsAltProbe().getCurrent()
      )
    let ended = false
    let disposed = false
    const standalone = openStandaloneTerminal({
      container,
      options: buildPreviewTerminalOptions({
        settings,
        terminalInput: null,
        macOptionIsMeta: getMacOptionAsAlt() === 'true',
        theme,
        themeMode: appearance?.mode ?? 'dark',
        cols: 80,
        rows: 24,
        scrollback: 5_000
      }),
      kittyKeyboardModes: new TerminalKittyKeyboardModeTracker({ kittyKeyboard: true }),
      sessionKey: `lan-workspace:${terminalId}`,
      sendInput: (data) => {
        if (disposed || ended) {
          return false
        }
        api.terminalWrite({ terminalId, data })
        return true
      },
      answersQueries: true,
      getSettings,
      getMacOptionAsAlt,
      getTerminalInput: () => null
    })
    if (!standalone) {
      setPhase({
        kind: 'failed',
        detail: translate(
          'lanWorkspace.terminalUnavailable',
          'Orca could not open the remote terminal.'
        )
      })
      return
    }
    const { terminal } = standalone
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    fit.fit()

    const unsubscribe = api.onMessage((message) => {
      if (!('terminalId' in message) || message.terminalId !== terminalId || disposed) {
        return
      }
      if (message.kind === 'terminal-exit') {
        ended = true
        terminal.options.disableStdin = true
        setPhase({ kind: 'ended' })
        return
      }
      standalone.write(message.data, {
        live: true,
        onDone: () => {
          if (!disposed) {
            api.terminalAck({ terminalId, chars: message.data.length })
          }
        }
      })
    })
    const resize = terminal.onResize(({ cols, rows }) => {
      if (!disposed && !ended) {
        api.terminalResize({ terminalId, cols, rows })
      }
    })
    const observer = new ResizeObserver(() => {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) {
        fit.fit()
      }
    })
    observer.observe(container)
    // The first setup in React's development replay is disposed before the PTY is opened.
    void Promise.resolve()
      .then(() =>
        disposed
          ? undefined
          : api.openTerminal({ terminalId, cols: terminal.cols, rows: terminal.rows })
      )
      .then(
        () => {
          if (!disposed && !ended) {
            api.terminalResize({ terminalId, cols: terminal.cols, rows: terminal.rows })
            setPhase({ kind: 'ready' })
            terminal.focus()
          }
        },
        (failure: unknown) => {
          if (!disposed && !ended) {
            ended = true
            terminal.options.disableStdin = true
            setPhase({ kind: 'failed', detail: readIpcErrorDetail(failure) ?? String(failure) })
          }
        }
      )
    return () => {
      disposed = true
      observer.disconnect()
      resize.dispose()
      unsubscribe()
      standalone.dispose()
    }
  }, [api, terminalId])

  return (
    <div className="grid gap-2">
      <div
        role="region"
        aria-label={t('lanWorkspace.terminal', 'Remote terminal')}
        className="h-[min(50dvh,28rem)] min-h-32 overflow-hidden rounded-md border border-border bg-background p-2"
      >
        <div ref={containerRef} className="size-full min-w-0" />
      </div>
      {phase.kind === 'opening' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('lanWorkspace.terminalOpening', 'Opening the remote terminal…')}
        </p>
      ) : null}
      {phase.kind === 'ended' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('lanWorkspace.terminalEnded', 'Remote terminal ended. Reconnect to open it again.')}
        </p>
      ) : null}
      {phase.kind === 'failed' ? <DialogError>{phase.detail}</DialogError> : null}
    </div>
  )
}
