import { translateMain } from '../../i18n/main-i18n'

export function translateLanWorkspacePrerequisiteError(error: unknown): unknown {
  if (
    !(error instanceof Error) ||
    error.name !== 'LanWorkspacePrerequisiteError' ||
    !('reason' in error)
  ) {
    return error
  }

  switch (error.reason) {
    case 'missing-sshfs':
      return new Error(
        translateMain(
          'lanWorkspace.missingSshfs',
          'SSH connected. The remote session could not find sshfs in its PATH.'
        )
      )
    case 'missing-fuse-device':
      return new Error(
        translateMain(
          'lanWorkspace.missingFuseDevice',
          'SSH connected. The remote session cannot see /dev/fuse, which SSHFS needs to mount the project.'
        )
      )
    case 'missing-unmount-helper':
      return new Error(
        translateMain(
          'lanWorkspace.missingUnmountHelper',
          'SSH connected. The remote session could not find fusermount3 or fusermount to clean up the mount.'
        )
      )
    case 'missing-mount-status':
      return new Error(
        translateMain(
          'lanWorkspace.missingMountStatus',
          'SSH connected. The remote session has neither mountpoint nor a readable /proc/self/mountinfo.'
        )
      )
    case 'missing-macfuse':
      return new Error(
        translateMain(
          'lanWorkspace.missingMacFuse',
          'SSH connected. Install macFUSE on the remote Mac with brew install --cask sshfs-mac.'
        )
      )
    case 'unsupported-os':
      return new Error(
        translateMain(
          'lanWorkspace.unsupportedRemoteOs',
          'LAN workspaces support remote macOS and Linux hosts.'
        )
      )
    default:
      return error
  }
}
