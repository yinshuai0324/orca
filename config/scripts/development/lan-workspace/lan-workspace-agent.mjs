import { quotePosixShell } from '../../../../src/shared/shell/launch/shell-argument-quoting.ts'
import { LAN_WORKSPACE_AGENTS } from '../../../../src/shared/remote-runtime/lan-workspace/lan-workspace-api.ts'
import { remoteToolPath } from './lan-workspace-mount.mjs'

export const discoverRemoteAgents = `
${remoteToolPath}
for agent in ${LAN_WORKSPACE_AGENTS.join(' ')}; do
  if command -v "$agent" >/dev/null 2>&1; then
    printf '%s\\n' "$agent"
  fi
done
`

export function readRemoteAgents({ code, stdout, stderr }) {
  if (code !== 0) {
    throw new Error(stderr || 'Could not check the remote AI CLIs.')
  }
  const found = stdout.split('\n')
  return LAN_WORKSPACE_AGENTS.filter((agent) => found.includes(agent))
}

function parseCodexEvent(event) {
  switch (event?.type) {
    case 'thread.started':
      return { sessionId: event.thread_id }
    case 'item.completed':
      return event.item?.type === 'agent_message' ? { answer: event.item.text } : {}
    case 'turn.completed':
      return { completed: true }
    case 'turn.failed':
      return { error: event.error?.message || 'Codex reported a failed turn.' }
    default:
      return {}
  }
}

function parseClaudeEvent(event) {
  if (event?.type === 'system' && event.subtype === 'init') {
    return { sessionId: event.session_id }
  }
  if (event?.type !== 'result') {
    return {}
  }
  if (event.subtype === 'success' && event.is_error === false && event.num_turns !== 0) {
    return { sessionId: event.session_id, completed: true, answer: event.result }
  }
  const errors = Array.isArray(event.errors)
    ? event.errors.filter((error) => typeof error === 'string')
    : []
  const detail = errors.join('\n') || (typeof event.result === 'string' && event.result)
  return { error: detail || 'Claude Code reported a failed turn.' }
}

const adapters = {
  codex: {
    name: 'Codex CLI',
    command(sessionId) {
      const resume = sessionId ? ` resume ${quotePosixShell(sessionId)}` : ''
      return `codex --ask-for-approval never -c 'sandbox_mode="workspace-write"' exec${resume} --json --skip-git-repo-check -`
    },
    parse: parseCodexEvent
  },
  claude: {
    name: 'Claude Code',
    command(sessionId) {
      const resume = sessionId ? ` --resume ${quotePosixShell(sessionId)}` : ''
      return `claude --print --verbose --output-format stream-json --permission-mode acceptEdits${resume}`
    },
    parse: parseClaudeEvent
  }
}

export function getRemoteAgent(agent) {
  return LAN_WORKSPACE_AGENTS.includes(agent) ? adapters[agent] : undefined
}
