import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '@/store/index'
import { ModalBoundary } from './app-root-surface-boundaries'

const LanWorkspaceDialog = lazy(
  () => import('../../components/settings/lan-workspace/LanWorkspaceDialog')
)

export function LanWorkspaceDialogHost(): React.JSX.Element | null {
  const open = useAppStore((state) => state.activeModal === 'lan-workspace')
  const targetId = useAppStore((state) => state.modalData.targetId)
  const targetLabel = useAppStore((state) => state.modalData.targetLabel)
  return open && typeof targetId === 'string' && typeof targetLabel === 'string' ? (
    <ModalBoundary boundaryId="modal.lan-workspace" resetKey>
      <LanWorkspaceDialog key={targetId} targetId={targetId} targetLabel={targetLabel} />
    </ModalBoundary>
  ) : null
}
