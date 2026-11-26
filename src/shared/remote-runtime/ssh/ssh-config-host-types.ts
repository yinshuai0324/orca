/** Concrete Host entry from ~/.ssh/config, for pickers that prefill the add-host form. */
export type SshConfigHostSummary = {
  alias: string
  hostname: string
  port: number
  username: string
  identityFile?: string
  proxyCommand?: string
  jumpHost?: string
  /** True when an Orca SSH target already uses this config alias. */
  alreadyInOrca: boolean
  /** Deleted alias remains explicitly selectable; passive/Add all import excludes it until re-adoption or save. */
  previouslyRemoved?: boolean
}

export const SSH_CONFIG_HOST_RESULT_LIMIT = 100

export type SshConfigHostListResult = {
  hosts: SshConfigHostSummary[]
  totalHostCount: number
  newHostCount: number
  matchCount: number
  hasMore: boolean
}

/** `refresh` re-reads ~/.ssh/config; filter keystrokes reuse the cached parse. */
export type SshConfigHostListArgs = { query?: string; refresh?: boolean }

/** Effective OpenSSH values used to prefill one manually managed target. */
export type SshConfigHostResolution = {
  alias: string
  hostname: string
  port: number
  username: string
  identityFiles: string[]
  identityAgent?: string
  identitiesOnly: boolean
  forwardAgent: boolean
  gssapiAuthentication?: boolean
  proxyCommand?: string
  proxyUseFdpass: boolean
  jumpHost?: string
}
