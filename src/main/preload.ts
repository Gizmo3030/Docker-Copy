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
  onMigrationProgress: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, update: { current: number; total: number; message: string }) =>
      handler(update)
    ipcRenderer.on('migration:progress', listener)
    return () => {
      ipcRenderer.removeListener('migration:progress', listener)
    }
  },
}

const meta = {
  preloadLoaded: true,
  versions: process.versions,
  platform: process.platform,
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('dockerCopy', api)
  contextBridge.exposeInMainWorld('dockerCopyMeta', meta)
} else {
  ;(window as Window & { dockerCopy?: DockerCopyApi }).dockerCopy = api
  ;(window as Window & { dockerCopyMeta?: typeof meta }).dockerCopyMeta = meta
}
