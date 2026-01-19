export type DockerEntityType = 'container' | 'volume' | 'network'

export interface HostConfig {
  host?: string
  user?: string
  port?: number
  identityFile?: string
}

export interface DockerContainerInfo {
  id: string
  name: string
  image: string
  status: string
  volumes: string[]
  networks: string[]
}

export interface DockerVolumeInfo {
  name: string
  driver: string
}

export interface DockerNetworkInfo {
  id: string
  name: string
  driver: string
}

export interface DockerInventory {
  containers: DockerContainerInfo[]
  volumes: DockerVolumeInfo[]
  networks: DockerNetworkInfo[]
}

export interface MigrationSelection {
  containers: string[]
  volumes: string[]
  networks: string[]
}

export interface MigrationOptions {
  includeContainers: boolean
  includeVolumes: boolean
  includeNetworks: boolean
  dryRun: boolean
}

export interface MigrationPlanStep {
  id: string
  label: string
  command?: string
  runOn?: 'source' | 'target' | 'local'
}

export interface MigrationPlan {
  steps: MigrationPlanStep[]
  warnings: string[]
}

export interface MigrationResult {
  ok: boolean
  message: string
  logs: string[]
}

export interface ConnectionTestResult {
  ok: boolean
  message: string
  logs: string[]
}

export interface DockerCopyApi {
  listInventory: (host: HostConfig) => Promise<DockerInventory>
  testConnection: (host: HostConfig) => Promise<ConnectionTestResult>
  createPlan: (
    source: HostConfig,
    target: HostConfig,
    selection: MigrationSelection,
    options: MigrationOptions,
  ) => Promise<MigrationPlan>
  runMigration: (
    source: HostConfig,
    target: HostConfig,
    selection: MigrationSelection,
    options: MigrationOptions,
  ) => Promise<MigrationResult>
  onMigrationProgress: (
    handler: (update: { current: number; total: number; message: string }) => void,
  ) => () => void
}
