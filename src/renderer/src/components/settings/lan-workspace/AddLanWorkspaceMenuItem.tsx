import { useEffect, useState } from 'react'
import { Server } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'

export function useLanWorkspaceAvailable(): boolean {
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    let active = true
    void window.api.lanWorkspace?.available().then(
      (supported) => {
        if (active) {
          setAvailable(supported)
        }
      },
      () => {}
    )
    return () => {
      active = false
    }
  }, [])

  return available
}

export function AddLanWorkspaceMenuItem(): React.JSX.Element {
  const t = useTranslate()
  const openModal = useAppStore((state) => state.openModal)

  return (
    <DropdownMenuItem onSelect={() => openModal('lan-workspace')}>
      <Server className="size-3.5" />
      {t('lanWorkspace.addHost', 'Add Remote Local Host')}
    </DropdownMenuItem>
  )
}
