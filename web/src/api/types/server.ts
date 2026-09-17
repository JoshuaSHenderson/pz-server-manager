// The managed servers themselves, their state, and the host they run on.

export interface ServerRow {
  id: string
  name: string
  container: string
  connect: string
  state: string
  discovered: boolean
  /** false = the container is visible but its data directory is not mounted into the manager. */
  managed: boolean
  /** false = force_install_dir is not mounted, so a clean reinstall is impossible. */
  reinstallable: boolean
  hidden?: boolean
}

export interface StaleServerRow {
  id: string
  name: string
  container: string
}

export interface ServersResponse {
  default: string
  servers: ServerRow[]
  hidden: ServerRow[]
  stale: StaleServerRow[]
}

export interface StatusResponse {
  status: string
  startedAt?: string
  server?: string
}

export interface SysInfo {
  cpu: string
  mem: string
  memPct: string
  disk: { size: string; used: string; avail: string; pct: string }
}

export interface ServerTime {
  hour: number
  minute: number
  display: string
}

export interface Player {
  username: string
  displayName?: string
  accesslevel: string
  admin: number | boolean
  moderator: number | boolean
  banned: number | boolean
  lastConnection?: string
}

export interface PlayersResponse {
  players: Player[]
}

export interface OnlinePlayersResponse {
  online: number
  players: string[]
}
