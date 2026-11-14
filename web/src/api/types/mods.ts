// Workshop items, collections, downloads, and everything that reasons about them.

/** 'collection' means the id is really a collection stub, not a mod — see the repair endpoint. */
export type ModStatus = 'ok' | 'missing' | 'collection'

export interface ModCollectionRef {
  id: string
  title: string
}

export interface Mod {
  workshopId: string
  title: string
  /** Every mod id this one Workshop item ships. Variant packs ship several. */
  modIds: string[]
  modFolders: string[]
  status: ModStatus
  /** The subset of modIds currently named in Mods=. */
  enabledIds: string[]
  /** 1-based positions in Mods=, one per enabled id, to match the load-order editor. */
  orderPositions: number[]
  minOrder: number | null
  loadOrderTotal: number
  error: string | null
  tags: string[]
  collections: ModCollectionRef[]
}

export interface ModsResponse {
  mods: Mod[]
}

export interface QueueEntry {
  id: string
  source: string
  collectionId: string | null
  status: 'queued' | 'installed' | 'failed'
  queuedAt: string
  updatedAt: string
  error?: string
  modIds?: string[]
  title?: string
}

export interface ActiveDownload {
  workshopId: string
  status: 'downloading' | 'pending'
  downloaded: number
  total: number
  pct: number
}

export interface DownloadsResponse {
  active: ActiveDownload[]
  queue: QueueEntry[]
}

export type DependencyIssueType = 'incompatible' | 'missing' | 'disabled' | 'order'

export interface DependencyIssue {
  type: DependencyIssueType
  modId: string
  dependency: string
  modIndex?: number
  dependencyIndex?: number
  modName: string | null
  modWorkshopId: string | null
  dependencyName: string | null
  /** The real-cased id, for enabling. Null when the dependency is not installed. */
  dependencyModId: string | null
  dependencyWorkshopId: string | null
}

/**
 * An ignore the operator has recorded. `stale` means its mod is no longer enabled, so the pairing
 * can never match again — that is what a mod id rename leaves behind. Reported rather than deleted,
 * because clearing it is still the operator's decision.
 */
export interface IgnoredDependency {
  key: string
  modId: string
  dependency: string
  stale: boolean
}

export interface DependenciesResponse {
  issues: DependencyIssue[]
  ignored: IgnoredDependency[]
  checked: number
  installedCount: number
}

export interface OrderEntry {
  modId: string
  index: number
  name: string
  workshopId: string | null
  /** Surfaced inline so the ordering constraints are visible while dragging. */
  loadModAfter: string[]
  installed: boolean
}

export interface OrderResponse {
  mods: OrderEntry[]
  backups: OrderBackup[]
}

export interface OrderBackup {
  file: string
  savedAt: string
  label: string
  count: number
}

export interface AuditOrphanItem {
  workshopId: string
  folders: string[]
  bytes: number
}

export interface AuditOrphanFolder {
  folder: string
  bytes: number
}

export interface DuplicateModIdProvider {
  workshopId: string
  folder: string
}

/** A mod id claimed by more than one folder. PZ picks by scan order, so the server boots
 *  differently on consecutive starts — the "restart it twice and it works" symptom. */
export interface DuplicateModId {
  modId: string
  providers: DuplicateModIdProvider[]
}

export interface AuditResponse {
  registered: number
  enabled: number
  onDisk: number
  unregistered: AuditOrphanItem[]
  missingContent: string[]
  orphanFolders: AuditOrphanFolder[]
  phantomEnabled: string[]
  installedNotEnabled: string[]
  duplicateIds: DuplicateModId[]
  notLoadable: string[]
  reclaimableBytes: number
  reclaimableHuman: string
  freeBytes: number
  freeHuman: string
}

export interface DriftIssue {
  id: string
  kind: 'clientBlocked' | 'orphan' | string
  folder: string
  suggest: string[]
  buildsIdentical: boolean | null
}

export interface DriftStale {
  folder: string
  workshopId: string
  workshop: string
  local: string | null
}

export interface DriftReport {
  ok: string[]
  issues: DriftIssue[]
  stale: DriftStale[]
  checkedAt: string
}

export interface ReinstallState {
  workshopId: string
  step: string
  startedAt: string
  finishedAt: string | null
  ok: boolean
  error: string | null
  quarantine: string | null
  holdsContainer?: boolean
  addedModIds?: string[]
  rolledBack?: boolean
  strandedDown?: boolean
}

export interface ReinstallResponse {
  available: boolean
  busy: boolean
  state: ReinstallState | null
}

/** Shape on disk: { "<workshopId>": ["<folder>", ...] }. */
export type ExcludeMap = Record<string, string[]>

export interface ExcludesResponse {
  duplicates: DuplicateModId[]
  excludes: ExcludeMap
}

export interface Collection {
  id: string
  title: string
  items: string[]
  itemCount: number
  installedCount: number
  missingCount: number
  droppedItems?: string[]
  lastSynced?: string
  nestedCollections?: string[]
}

export interface CollectionsResponse {
  collections: Collection[]
}

export interface DroppedMod {
  id: string
  collectionId: string
  collectionTitle: string
  title?: string
}

export interface AutoSync {
  enabled: boolean
  intervalHours: number
  lastRun?: string | null
}

export interface AutoUpdateConfig {
  enabled: boolean
  restartWhenEmpty: boolean
  lastCheck: string | null
  lastRestart: string | null
  lastResult: string
  pending: string[]
  /** How many Workshop items have a recorded baseline stamp. */
  tracked: number
  checkIntervalHours: number
}

export type AlertSeverity = 'error' | 'warn' | 'info'

export interface Alert {
  severity: AlertSeverity
  category: string
  title: string
  detail: string
  tab?: string
}

export interface AlertsResponse {
  alerts: Alert[]
  counts: { error: number; warn: number; info: number }
  generatedAt: string
}
