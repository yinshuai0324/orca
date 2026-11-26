import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '@/store/index'
import { ModalBoundary } from './app-root-surface-boundaries'

const LanWorkspaceDialog = lazy(
  () => import('../../components/settings/lan-workspace/LanWorkspaceDialog')
)

export function LanWorkspaceDialogHost(): React.JSX.Element | null {
  const open = useAppStore((state) => state.activeModal === 'lan-workspace')
  return open ? (
    <ModalBoundary boundaryId="modal.lan-workspace" resetKey>
      <LanWorkspaceDialog />
    </ModalBoundary>
  ) : null
}
