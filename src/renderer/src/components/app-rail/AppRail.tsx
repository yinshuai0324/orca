import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Layers } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { useHelpMenuController } from '@/components/sidebar/chrome/help-menu-controller'
import { useSetupGuideProgressSnapshot } from '@/components/setup-guide/setup-guide-progress-snapshot'
import { nextAppRailFocusIndex } from './app-rail-roving-focus'
import { WORKSPACE_LIST_REGION_ID } from './app-rail-layout'
import {
  activateWorkspacesRailItem,
  isWorkspacesRailItemActive,
  navigateFromRail
} from './app-rail-navigation'
import {
  APP_RAIL_ICON_SIZE,
  APP_RAIL_ICON_STROKE_WIDTH,
  APP_RAIL_ITEM_ATTRIBUTE,
  AppRailButton,
  RailItem,
  isAppRailItemId,
  type AppRailItemId
} from './AppRailButton'
import { AppRailAccountMenu } from './AppRailAccountMenu'
import { railItemOwningFocus } from './app-rail-focus-ownership'
import { useWorkspaceListRegionPresent } from './workspace-list-region-presence'
import { getTitlebarSidebarToggle } from '@/app-shell/chrome/titlebar-sidebar-toggle-ref'

/** Icon-only app navigation below the left titlebar; one tab stop, arrow keys move within it. */
export function AppRail({
  listVisible,
  style
}: {
  listVisible: boolean
  style?: React.CSSProperties
}): React.JSX.Element {
  const t = useTranslate()
  const workspacesActive = useAppStore(isWorkspacesRailItemActive)
  const settingsActive = useAppStore((s) => s.activeView === 'settings')
  const listShowsWorkspaces = useAppStore((s) => (s.sidebarBody ?? 'workspaces') === 'workspaces')
  const listRegionPresent = useWorkspaceListRegionPresent()
  const setupProgress = useSetupGuideProgressSnapshot()
  // The account menu's Milestones row and ring read the app-wide setup reading; the rail runs no setup checks itself.
  const milestones = useMemo(
    () =>
      setupProgress?.ready && setupProgress.done < setupProgress.total
        ? { done: setupProgress.done, total: setupProgress.total }
        : null,
    [setupProgress]
  )
  // Milestones sits at the top of the account menu, so Help's own list leaves it out; the menu has its own groups, so
  // Help's rows come grouped. The rail owns the controller so its feedback dialog outlives the account menu closing.
  const help = useHelpMenuController(null, 'grouped')

  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const [lastFocusedItem, setLastFocusedItem] = useState<AppRailItemId | null>(null)
  const tabStopItem =
    lastFocusedItem ?? (settingsActive && !workspacesActive ? 'account' : 'workspaces')

  // Turning the experiment off unmounts the rail (cleanup runs before its nodes leave the DOM): if a rail button or a
  // menu opened from one has focus, hand it to the titlebar's sidebar toggle, else blur. Other focus is untouched.
  useLayoutEffect(() => {
    const ownedToolbar = toolbarRef.current
    return () => {
      if (!ownedToolbar || railItemOwningFocus(ownedToolbar) === null) {
        return
      }
      const fallback = getTitlebarSidebarToggle()
      if (fallback) {
        fallback.focus({ preventScroll: true })
      } else {
        const active = document.activeElement
        if (active instanceof HTMLElement) {
          active.blur()
        }
      }
    }
  }, [])

  const navigationLabel = t('appRail.navigationLabel', 'App navigation')
  // The toolbar inside the landmark gets its own name so screen readers don't hear "App navigation" twice.
  const toolsLabel = t('appRail.toolsLabel', 'App tools')
  const workspacesLabel = t('appRail.workspaces', 'Workspaces')
  const openSettings = (): void => useAppStore.getState().openSettingsPage()

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(
      toolbarRef.current?.querySelectorAll<HTMLElement>(`[${APP_RAIL_ITEM_ATTRIBUTE}]`) ?? []
    )
    // Capture phase + preventDefault keeps Radix menu triggers from opening on ArrowDown; menu content portals but still propagates here, so only rail buttons rove.
    const target = event.target
    const index = target instanceof HTMLElement ? items.indexOf(target) : -1
    if (index === -1) {
      return
    }
    // The account button is last, so ArrowDown opens its menu (Radix's trigger key) instead of wrapping to the top.
    if (
      event.key === 'ArrowDown' &&
      items[index].getAttribute(APP_RAIL_ITEM_ATTRIBUTE) === 'account'
    ) {
      return
    }
    const next = nextAppRailFocusIndex(event.key, index, items.length)
    if (next === null) {
      return
    }
    event.preventDefault()
    items[next].focus()
  }

  const handleFocus = (event: React.FocusEvent<HTMLDivElement>): void => {
    const itemId =
      event.target instanceof HTMLElement
        ? event.target.getAttribute(APP_RAIL_ITEM_ATTRIBUTE)
        : null
    if (isAppRailItemId(itemId)) {
      setLastFocusedItem(itemId)
    }
  }

  return (
    <nav
      aria-label={navigationLabel}
      className="flex min-h-0 w-10 flex-1 shrink-0 flex-col border-r border-worktree-sidebar-border bg-worktree-sidebar"
      style={style}
    >
      {/* Why pb-1: the account button lines up with the list footer icons and its focus ring stays unclipped. */}
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-orientation="vertical"
        aria-label={toolsLabel}
        className="flex min-h-0 flex-1 flex-col items-center justify-between overflow-hidden pt-2 pb-1"
        onKeyDownCapture={handleKeyDown}
        onFocus={handleFocus}
      >
        <div className="flex flex-col items-center gap-2.5">
          <RailItem tooltip={workspacesLabel}>
            <AppRailButton
              itemId="workspaces"
              icon={
                <Layers
                  size={APP_RAIL_ICON_SIZE}
                  strokeWidth={APP_RAIL_ICON_STROKE_WIDTH}
                  aria-hidden
                />
              }
              label={workspacesLabel}
              active={workspacesActive}
              // Expansion describes only the content actually in the list column.
              aria-expanded={listShowsWorkspaces ? listVisible : undefined}
              aria-controls={
                listShowsWorkspaces && listRegionPresent ? WORKSPACE_LIST_REGION_ID : undefined
              }
              tabStop={tabStopItem === 'workspaces'}
              onClick={() => navigateFromRail(() => activateWorkspacesRailItem(useAppStore))}
            />
          </RailItem>
        </div>
        <div className="flex flex-col items-center gap-2.5">
          <AppRailAccountMenu
            help={help}
            milestones={milestones}
            settingsActive={settingsActive}
            onOpenSettings={openSettings}
            tabStop={tabStopItem === 'account'}
          />
        </div>
        {/* Rendered outside the account menu so Send Feedback's dialog survives the menu closing. */}
        {help.dialog}
      </div>
    </nav>
  )
}
