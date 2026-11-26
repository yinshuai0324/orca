export const LAN_WORKSPACE_CHANNELS = {
  available: 'lan-workspace:available',
  chooseDirectory: 'lan-workspace:choose-directory',
  connect: 'lan-workspace:connect',
  turn: 'lan-workspace:turn',
  disconnect: 'lan-workspace:disconnect',
  message: 'lan-workspace:message'
} as const

export const LAN_WORKSPACE_AGENTS = ['codex', 'claude'] as const

export type LanWorkspaceAgent = (typeof LAN_WORKSPACE_AGENTS)[number]

export type LanWorkspaceMount = {
  path: string
  agents: LanWorkspaceAgent[]
}

export type LanWorkspaceTurn = {
  agent: LanWorkspaceAgent
  prompt: string
}

export type LanWorkspaceConnection = {
  host: string
  username: string
  password: string
  directory: string
  startCommand: string
  previewUrl: string
}

export type LanWorkspaceMessage =
  | { kind: 'assistant'; agent: LanWorkspaceAgent; text: string }
  | { kind: 'dev'; text: string }
  | { kind: 'previewing' | 'disconnected' }

export type LanWorkspaceApi = {
  available(): Promise<boolean>
  chooseDirectory(): Promise<string | null>
  connect(input: LanWorkspaceConnection): Promise<LanWorkspaceMount>
  turn(input: LanWorkspaceTurn): Promise<void>
  disconnect(): Promise<void>
  onMessage(listener: (message: LanWorkspaceMessage) => void): () => void
}
