// servertest.ini, the sandbox file, the restart schedule, backups and notifications.

export interface Schedule {
  enabled: boolean
  mode: 'daily' | 'interval'
  hour: number
  minute: number
  intervalHours: number
}

export interface BackupFile {
  name: string
  size: number
  mtime: string
}

export interface BackupsResponse {
  startup: BackupFile[]
  version: BackupFile[]
  manual: BackupFile[]
}

export type SandboxFieldType = 'boolean' | 'enum' | 'int' | 'float' | 'string' | 'raw'

export interface SandboxField {
  key: string
  section: string
  line: number
  type: SandboxFieldType
  value: boolean | number | string
  raw: string
  description: string
  options: { value: string; label: string }[] | null
  min: number | null
  max: number | null
  default: string | null
}

export interface SandboxSection {
  name: string
  fields: SandboxField[]
}

export interface SandboxResponse {
  sections: SandboxSection[]
}

export interface SandboxBackup {
  name: string
  mtime: string
}

export interface NotificationEvents {
  serverStart: boolean
  serverStop: boolean
  serverCrash: boolean
  serverReady?: boolean
  lowDisk: boolean
  downloadComplete: boolean
  playerJoin: boolean
  playerLeave: boolean
  playerSpawned?: boolean
  playerDied: boolean
  playerKicked: boolean
  modsNotLoaded?: boolean
  modDrift?: boolean
}

export interface DiscordConfig {
  enabled: boolean
  webhookUrlSet: boolean
  messageId: string
  richCard: boolean
  template: string
  iconUrl?: string
}

/** What GET /api/notifications returns — credentials are reported as set/unset, never sent. */
export interface NotificationConfig {
  enabled: boolean
  tokenSet: boolean
  userKeySet: boolean
  events: NotificationEvents
  lowDiskThresholdGB: number
  discord: DiscordConfig
}

export interface DiscordDetected {
  externalIp: string
  port: string
  version: string
}

export type IniConfig = Record<string, string>
