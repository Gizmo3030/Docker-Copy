import { contextBridge, ipcRenderer } from 'electron'
import type {
  DockerCopyApi,
  HostConfig,
  MigrationOptions,
  MigrationSelection,
} from '../shared/types'

const api: DockerCopyApi = {
  listInventory: (host: HostConfig) => ipcRenderer.invoke('inventory:list', host),
  testConnection: (host: HostConfig) => ipcRenderer.invoke('connection:test', host),
  createPlan: (
    source: HostConfig,
    target: HostConfig,
    selection: MigrationSelection,
    options: MigrationOptions,
  ) => ipcRenderer.invoke('migration:plan', source, target, selection, options),
  runMigration: (
    source: HostConfig,
    target: HostConfig,
    selection: MigrationSelection,
    options: MigrationOptions,
  ) => ipcRenderer.invoke('migration:run', source, target, selection, options),
}

contextBridge.exposeInMainWorld('dockerCopy', api)
