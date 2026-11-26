import { quotePosixShell } from '../../../../src/shared/shell/launch/shell-argument-quoting.ts'

export const remoteToolPath =
  'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH:/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin"'

const linuxMount = {
  check: `
orca_mounted() {
  if command -v mountpoint >/dev/null 2>&1; then
    mountpoint -q -- "$1"
    return
  fi
  while IFS=' ' read -r mount_id parent_id device root mount_path options; do
    if [ "$mount_path" = "$1" ]; then
      return 0
    fi
  done < /proc/self/mountinfo
  return 1
}
`,
  unmount: `
orca_unmount() {
  helper=$(command -v fusermount3 || command -v fusermount) || return
  "$helper" -uz -- "$1"
}
`
}

const macMount = {
  check: `
orca_mounted() {
  /sbin/mount | /usr/bin/grep -F -q " on $1 ("
}
`,
  unmount: `
orca_unmount() {
  /sbin/umount "$1"
}
`
}

const prerequisites = {
  common: [
    {
      check: 'command -v sshfs >/dev/null 2>&1',
      status: 41,
      reason: 'missing-sshfs',
      message: 'SSH connected, but sshfs was not found in the remote PATH.'
    }
  ],
  linux: [
    {
      check: 'test -c /dev/fuse',
      status: 42,
      reason: 'missing-fuse-device',
      message: 'SSH connected, but the remote session has no /dev/fuse device.'
    },
    {
      check: '(command -v fusermount3 >/dev/null 2>&1 || command -v fusermount >/dev/null 2>&1)',
      status: 43,
      reason: 'missing-unmount-helper',
      message: 'SSH connected, but neither fusermount3 nor fusermount was found in the remote PATH.'
    },
    {
      check: '(command -v mountpoint >/dev/null 2>&1 || test -r /proc/self/mountinfo)',
      status: 44,
      reason: 'missing-mount-status',
      message: 'SSH connected, but the remote session cannot check which directories are mounted.'
    }
  ],
  mac: [
    {
      check: 'test -d /Library/Filesystems/macfuse.fs',
      status: 46,
      reason: 'missing-macfuse',
      message: 'SSH connected, but macFUSE is missing on the remote Mac.'
    }
  ],
  supportedPlatform: {
    status: 47,
    reason: 'unsupported-os',
    message: 'LAN workspaces support remote macOS and Linux hosts.'
  }
}

function shellChecks(requirements) {
  return requirements.map(({ check, status }) => `${check} || exit ${status}`).join('\n')
}

export const prepareRemoteMount = `
${remoteToolPath}
platform=$(uname -s) || exit ${prerequisites.supportedPlatform.status}
case "$platform" in
  Linux) kind=linux; root=/tmp ;;
  Darwin) kind=mac-vfs; root=/private/tmp ;;
  *) exit ${prerequisites.supportedPlatform.status} ;;
esac
${shellChecks(prerequisites.common)}
case "$kind" in
  linux)
    ${shellChecks(prerequisites.linux)}
    ;;
  mac-vfs)
    ${shellChecks(prerequisites.mac)}
    version=$(/usr/bin/sw_vers -productVersion) || exit 1
    major=\${version%%.*}
    remaining=\${version#*.}
    minor=\${remaining%%.*}
    if [ "$major" -gt 15 ] || { [ "$major" -eq 15 ] && [ "$minor" -ge 4 ]; }; then
      kind=mac-fskit
    fi
    ;;
esac
path=$(mktemp -d "$root/orca-workspace.XXXXXXXXXX") || exit 1
printf '%s %s\\n' "$kind" "$path"
`

class LanWorkspacePrerequisiteError extends Error {
  constructor({ reason, message }) {
    super(message)
    this.name = 'LanWorkspacePrerequisiteError'
    this.reason = reason
  }
}

export function readRemoteMount({ code, stdout, stderr }) {
  const failure = [
    ...prerequisites.common,
    ...prerequisites.linux,
    ...prerequisites.mac,
    prerequisites.supportedPlatform
  ].find(({ status }) => status === code)
  if (failure) {
    throw new LanWorkspacePrerequisiteError(failure)
  }
  const match =
    /^(linux|mac-vfs|mac-fskit) (\/(?:private\/)?tmp\/orca-workspace\.[A-Za-z0-9]+)$/.exec(stdout)
  if (code !== 0 || !match || (match[1] === 'linux') !== match[2].startsWith('/tmp/')) {
    throw new Error(stderr || 'Could not prepare the remote mount directory.')
  }

  const [, kind, path] = match
  const { check, unmount } = kind === 'linux' ? linuxMount : macMount
  const target = quotePosixShell(path)
  const options =
    kind === 'mac-fskit' ? 'passive,dir_cache=no,backend=fskit' : 'passive,dir_cache=no'
  const mounted = `orca_mounted ${target}`
  const ready = `${mounted} && test -d ${target}`

  return {
    path,
    start: `${remoteToolPath}; exec sshfs -f -o ${options} :/ ${target}`,
    check: `${remoteToolPath}\n${check}\n${ready}`,
    shellDirectory: `${remoteToolPath}\n${check}\n${ready} && cd -- ${target}`,
    cleanup: `
      ${remoteToolPath}
      ${check}
      ${unmount}
      if ${mounted}; then
        orca_unmount ${target} || exit 1
      fi
      rmdir -- ${target}
    `
  }
}
