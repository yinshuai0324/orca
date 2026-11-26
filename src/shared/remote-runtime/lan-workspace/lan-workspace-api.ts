export const LAN_WORKSPACE_CHANNELS = {
  available: 'lan-workspace:available',
  chooseDirectory: 'lan-workspace:choose-directory',
  connect: 'lan-workspace:connect',
  openTerminal: 'lan-workspace:open-terminal',
  terminalWrite: 'lan-workspace:terminal-write',
  terminalResize: 'lan-workspace:terminal-resize',
  terminalAck: 'lan-workspace:terminal-ack',
  preview: 'lan-workspace:preview',
  disconnect: 'lan-workspace:disconnect',
  message: 'lan-workspace:message'
} as const

export type LanWorkspaceSessionInfo = { path: string | null; terminalId: string }

export type LanWorkspaceTerminalTarget = { terminalId: string }

export type LanWorkspaceTerminalSize = LanWorkspaceTerminalTarget & { cols: number; rows: number }

export type LanWorkspaceProject = {
  directory: string
  startCommand: string
  previewUrl: string
}

export type LanWorkspaceConnectInput = LanWorkspaceProject & {
  targetId: string
  mode: 'mount' | 'terminal'
}

export type LanWorkspaceMessage =
  | { kind: 'terminal-data'; terminalId: string; data: string }
  | { kind: 'terminal-exit'; terminalId: string; exitCode: number | null }
  | { kind: 'dev'; text: string }
  | { kind: 'preview'; state: 'starting' | 'ready' }
  | { kind: 'preview'; state: 'failed'; detail: string }
  | { kind: 'disconnected' }

export type LanWorkspaceApi = {
  available(): Promise<boolean>
  chooseDirectory(): Promise<string | null>
  connect(input: LanWorkspaceConnectInput): Promise<LanWorkspaceSessionInfo>
  openTerminal(input: LanWorkspaceTerminalSize): Promise<void>
  terminalWrite(input: LanWorkspaceTerminalTarget & { data: string }): void
  terminalResize(input: LanWorkspaceTerminalSize): void
  terminalAck(input: LanWorkspaceTerminalTarget & { chars: number }): void
  preview(): Promise<void>
  disconnect(): Promise<void>
  onMessage(listener: (message: LanWorkspaceMessage) => void): () => void
}
