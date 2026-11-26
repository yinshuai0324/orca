import { app, dialog, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { translateMain } from '../i18n/main-i18n'
import { isBackgroundLaunch } from '../window/activation/foreground-activation-policy'

type LanWorkspaceEntry = { openLanWorkspaceWindow(): Promise<void> }

export function createLanWorkspaceMenuItem(): MenuItemConstructorOptions | null {
  if (process.platform !== 'darwin' || app.isPackaged) {
    return null
  }

  const entry = pathToFileURL(
    join(
      process.env.ORCA_DEV_REPO_ROOT ?? app.getAppPath(),
      'config',
      'scripts',
      'development',
      'lan-workspace',
      'lan-workspace-window.mjs'
    )
  ).href
  return {
    id: 'lan-workspace',
    label: translateMain('menu.lanWorkspace', 'LAN Workspace…'),
    click: () => {
      void openLanWorkspace(entry)
    }
  }
}

async function openLanWorkspace(entry: string): Promise<void> {
  try {
    const feature: LanWorkspaceEntry = await import(/* @vite-ignore */ entry)
    await feature.openLanWorkspaceWindow()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[lan-workspace] Window failed to open:', message)
    if (!isBackgroundLaunch()) {
      dialog.showErrorBox('LAN Workspace', message)
    }
  }
}
