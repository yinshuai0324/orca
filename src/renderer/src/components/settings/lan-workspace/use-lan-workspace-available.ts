import { useEffect, useState } from 'react'

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
