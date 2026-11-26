import React from 'react'
import { CircleHelp, Settings } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  AddLanWorkspaceMenuItem,
  useLanWorkspaceAvailable
} from '@/components/settings/lan-workspace/AddLanWorkspaceMenuItem'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useShortcutKeyDetails } from '@/lib/keyboard/useShortcutLabel'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import { useSetupGuideProgress } from '../../setup-guide/use-setup-guide-progress'
import { useTranslate } from '@/i18n/use-translate'
import type { SetupMilestones } from './help-menu-controller'
import { HelpMenu } from './HelpMenu'

export function SettingsTooltipLabel(): React.JSX.Element {
  const t = useTranslate()
  const settingsShortcut = useShortcutKeyDetails('app.settings')
  return (
    <>
      {t('auto.components.sidebar.SidebarSettingsHelpMenu.a428c25998', 'Settings')}
      {settingsShortcut.keys.length > 0 ? (
        <ShortcutKeyCombo
          keys={settingsShortcut.keys}
          doubleTap={settingsShortcut.doubleTap}
          className="gap-0.5"
          keyCapClassName="min-w-0 border-background/20 bg-background/10 px-1 py-0 text-[10px] text-background shadow-none"
          separatorClassName="text-[10px] text-background/70"
        />
      ) : null}
    </>
  )
}

/** Milestones to show in Help, or null once core setup is done. Runs setup-guide refresh work while mounted. */
export function useSetupMilestones(): SetupMilestones | null {
  const setupProgress = useSetupGuideProgress(true, false, false)
  const show = setupProgress.ready && setupProgress.coreDoneCount < setupProgress.coreTotal
  const done = setupProgress.coreDoneCount
  const total = setupProgress.coreTotal
  return React.useMemo(() => (show ? { done, total } : null), [show, done, total])
}

export function SidebarSettingsHelpMenu(): React.JSX.Element {
  const t = useTranslate()
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const milestones = useSetupMilestones()
  const lanWorkspaceAvailable = useLanWorkspaceAvailable()
  const settingsLabel = t('auto.components.sidebar.SidebarSettingsHelpMenu.a428c25998', 'Settings')
  const settingsButton = (
    <Button
      variant="ghost"
      size="icon-xs"
      type="button"
      aria-label={settingsLabel}
      className="text-muted-foreground"
      onClick={lanWorkspaceAvailable ? undefined : openSettingsPage}
    >
      <Settings className="size-3.5" />
    </Button>
  )
  return (
    <div className="flex items-center gap-1">
      <DropdownMenu modal={false}>
        <Tooltip>
          <TooltipTrigger asChild>
            {lanWorkspaceAvailable ? (
              <DropdownMenuTrigger asChild>{settingsButton}</DropdownMenuTrigger>
            ) : (
              settingsButton
            )}
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4} className="flex items-center gap-1.5">
            <SettingsTooltipLabel />
          </TooltipContent>
        </Tooltip>
        {lanWorkspaceAvailable ? (
          <DropdownMenuContent side="top" align="start" sideOffset={4}>
            <DropdownMenuItem onSelect={openSettingsPage}>
              <Settings className="size-3.5" />
              {settingsLabel}
            </DropdownMenuItem>
            <AddLanWorkspaceMenuItem />
          </DropdownMenuContent>
        ) : null}
      </DropdownMenu>
      <HelpMenu
        side="top"
        align="start"
        milestones={milestones}
        trigger={
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label={t('auto.components.sidebar.SidebarSettingsHelpMenu.2991a0106c', 'Help')}
            className="text-muted-foreground"
          >
            <CircleHelp className="size-3.5" />
          </Button>
        }
      />
    </div>
  )
}
