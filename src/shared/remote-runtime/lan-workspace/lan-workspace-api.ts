export const LAN_WORKSPACE_CHANNELS = {
  available: 'lan-workspace:available',
  chooseDirectory: 'lan-workspace:choose-directory',
  connect: 'lan-workspace:connect',
  turn: 'lan-workspace:turn',
  disconnect: 'lan-workspace:disconnect',
  message: 'lan-workspace:message'
} as const

export type LanWorkspaceConnection = {
  host: string
  username: string
  password: string
  directory: string
  startCommand: string
  previewUrl: string
}

export type LanWorkspaceMessage =
  | { kind: 'assistant' | 'dev'; text: string }
  | { kind: 'previewing' | 'disconnected' }

export type LanWorkspaceApi = {
  available(): Promise<boolean>
  chooseDirectory(): Promise<string | null>
  connect(input: LanWorkspaceConnection): Promise<string>
  turn(prompt: string): Promise<void>
  disconnect(): Promise<void>
  onMessage(listener: (message: LanWorkspaceMessage) => void): () => void
}
