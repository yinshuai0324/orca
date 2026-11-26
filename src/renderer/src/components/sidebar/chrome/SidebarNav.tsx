import React from 'react'
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store/index'
import { useShortcutKeyComboDetails } from '@/lib/keyboard/useShortcutLabel'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import { SetupGuideSidebarEntry } from '../../setup-guide/SetupGuideSidebarEntry'
import { SIDEBAR_NAV_DIMMED_ICON_CLASS_NAME } from './sidebar-nav-controls'
import { useTranslate } from '@/i18n/use-translate'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { useBotsEnabled } from '@/lib/bot-catalog'

export function shouldShowMobileButton(
  settings: Partial<Pick<GlobalSettings, 'showMobileButton'>> | null | undefined
): boolean {
  return settings?.showMobileButton !== false
}

export function shouldShowAutomationsButton(
  settings: Partial<Pick<GlobalSettings, 'showAutomationsButton'>> | null | undefined
): boolean {
  return settings?.showAutomationsButton !== false
}

export function shouldShowArtifactsButton(
  settings: Partial<Pick<GlobalSettings, 'showArtifactsButton'>> | null | undefined
): boolean {
  return settings?.showArtifactsButton === true
}

export function shouldShowSkillsButton(
  settings: Partial<Pick<GlobalSettings, 'showSkillsButton'>> | null | undefined
): boolean {
  return settings?.showSkillsButton === true
}

export function shouldShowAgentDashboardButton(
  settings: Partial<Pick<GlobalSettings, 'experimentalAgentDashboardPopout'>> | null | undefined
): boolean {
  return settings?.experimentalAgentDashboardPopout === true
}

const AgentDashboardSidebarEntry = lazyWithRetry(
  () => import('../../dashboard/sidebar/AgentDashboardSidebarEntry')
)

const SidebarNav = React.memo(function SidebarNav() {
  const t = useTranslate()
  const botsEnabled = useBotsEnabled()
  // Subscribe across this memo boundary; translate still handles pseudo-localization.
  useTranslation()
  const worktreePaletteShortcutCombos = useShortcutKeyComboDetails('worktree.palette')
  const openModal = useAppStore((s) => s.openModal)
  const showAgentDashboardButton = useAppStore((s) => shouldShowAgentDashboardButton(s.settings))

  return (
    <div
      className="flex flex-col gap-0.5 px-2 pt-2 pb-1"
      data-contextual-tour-target="sidebar-navigation"
    >
      <button
        type="button"
        onClick={() => openModal('worktree-palette')}
        aria-label={
          botsEnabled
            ? t('bots.palette.sidebarSearchLabel', 'Search bots, workspaces, and browser tabs')
            : t(
                'auto.components.sidebar.SidebarNav.0c3395fd32',
                'Search worktrees and browser tabs'
              )
        }
        className="group flex w-full items-center gap-2 rounded-md bg-worktree-sidebar-foreground/5 px-2 py-1.5 text-left text-[13px] font-medium tracking-tight text-worktree-sidebar-foreground/60 transition-colors hover:bg-worktree-sidebar-foreground/8"
      >
        <Search
          className={`size-4 shrink-0 ${SIDEBAR_NAV_DIMMED_ICON_CLASS_NAME}`}
          strokeWidth={1.75}
        />
        <span className="flex-1">
          {t('auto.components.sidebar.SidebarNav.80611a8b10', 'Search')}
        </span>
        <span className="pointer-events-none hidden shrink-0 items-center gap-1 group-hover:flex group-focus-within:flex">
          {worktreePaletteShortcutCombos.map((combo) => (
            <ShortcutKeyCombo
              key={combo.keys.join('-')}
              keys={combo.keys}
              doubleTap={combo.doubleTap}
              className="inline-flex gap-0.5"
              keyCapClassName="min-w-4 border-worktree-sidebar-border/80 bg-worktree-sidebar-foreground/8 px-1 py-px text-[9px] text-worktree-sidebar-foreground/55 shadow-none"
              separatorClassName="text-[9px] text-worktree-sidebar-foreground/45"
            />
          ))}
        </span>
      </button>
      <SetupGuideSidebarEntry />
      {showAgentDashboardButton ? (
        <React.Suspense fallback={null}>
          <AgentDashboardSidebarEntry />
        </React.Suspense>
      ) : null}
    </div>
  )
})

export default SidebarNav
