import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HostConfig, MigrationOptions, MigrationSelection } from '../shared/types'
import { listContainers, listNetworks, listVolumes, testDockerConnection } from './docker.js'
import { createMigrationPlan, runMigration } from './migration.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const preloadPath = path.join(__dirname, 'preload.js')
  if (!existsSync(preloadPath)) {
    console.warn(`[preload] missing at ${preloadPath}`)
  } else {
    console.log(`[preload] loading ${preloadPath}`)
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl || process.env.NODE_ENV === 'development') {
    mainWindow.loadURL(devServerUrl ?? 'http://localhost:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

ipcMain.handle('inventory:list', async (_event, host: HostConfig) => {
  const [containers, volumes, networks] = await Promise.all([
    listContainers(host),
    listVolumes(host),
    listNetworks(host),
  ])
  return { containers, volumes, networks }
})

ipcMain.handle('connection:test', async (_event, host: HostConfig) => testDockerConnection(host))

ipcMain.handle(
  'migration:plan',
  async (_event, source: HostConfig, target: HostConfig, selection: MigrationSelection, options: MigrationOptions) =>
    createMigrationPlan(source, target, selection, options),
)

ipcMain.handle(
  'migration:run',
  async (event, source: HostConfig, target: HostConfig, selection: MigrationSelection, options: MigrationOptions) =>
    runMigration(event, source, target, selection, options),
)
