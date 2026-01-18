import { useMemo, useState } from 'react'
import type {
  ConnectionTestResult,
  DockerInventory,
  HostConfig,
  MigrationOptions,
  MigrationPlan,
  MigrationResult,
  MigrationSelection,
} from './shared/types'
import './App.css'

function App() {
  const [sourceHost, setSourceHost] = useState<HostConfig>({})
  const [useLocalSource, setUseLocalSource] = useState(true)
  const [targetHost, setTargetHost] = useState<HostConfig>({})
  const [inventory, setInventory] = useState<DockerInventory>({
    containers: [],
    volumes: [],
    networks: [],
  })
  const [selection, setSelection] = useState<MigrationSelection>({
    containers: [],
    volumes: [],
    networks: [],
  })
  const [options, setOptions] = useState<MigrationOptions>({
    includeContainers: true,
    includeVolumes: true,
    includeNetworks: true,
    dryRun: true,
  })
  const [plan, setPlan] = useState<MigrationPlan | null>(null)
  const [result, setResult] = useState<MigrationResult | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [sourceTest, setSourceTest] = useState<ConnectionTestResult | null>(null)
  const [targetTest, setTargetTest] = useState<ConnectionTestResult | null>(null)

  const getDockerApi = () => {
    if (window.dockerCopy) {
      return window.dockerCopy
    }

    const unsafeWindow = window as Window & {
      require?: (module: string) => { ipcRenderer?: { invoke: (...args: unknown[]) => Promise<unknown> } }
    }
    const electron = unsafeWindow.require?.('electron')
    const ipcRenderer = electron?.ipcRenderer
    if (!ipcRenderer) {
      return null
    }

    return {
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
  }

  const isSelectionEmpty = useMemo(
    () =>
      selection.containers.length === 0 &&
      selection.volumes.length === 0 &&
      selection.networks.length === 0,
    [selection],
  )

  const canTestSource = useMemo(
    () => useLocalSource || Boolean(sourceHost.host && sourceHost.user),
    [sourceHost.host, sourceHost.user, useLocalSource],
  )

  const canTestTarget = useMemo(
    () => Boolean(targetHost.host && targetHost.user),
    [targetHost.host, targetHost.user],
  )

  const handleTestConnection = async (
    host: HostConfig,
    setTest: (result: ConnectionTestResult) => void,
  ) => {
    setIsBusy(true)
    try {
      const api = getDockerApi()
      if (!api) {
        throw new Error('Electron preload API is unavailable. Launch the Electron app to access Docker.')
      }
      const testResult = await api.testConnection(host)
      setTest(testResult)
    } catch (error) {
      setTest({
        ok: false,
        message: 'Connection test failed to start.',
        logs: [error instanceof Error ? error.message : 'Unknown error'],
      })
    } finally {
      setIsBusy(false)
    }
  }

  const handleLoadInventory = async () => {
    setIsBusy(true)
    setResult(null)
    setPlan(null)
    try {
      const api = getDockerApi()
      if (!api) {
        throw new Error('Electron preload API is unavailable. Launch the Electron app to access Docker.')
      }
      const data = await api.listInventory(sourceHost)
      setInventory(data)
      setSelection({ containers: [], volumes: [], networks: [] })
    } catch (error) {
      setResult({
        ok: false,
        message: 'Failed to load inventory.',
        logs: [error instanceof Error ? error.message : 'Unknown error'],
      })
    } finally {
      setIsBusy(false)
    }
  }

  const handleCreatePlan = async () => {
    setIsBusy(true)
    setResult(null)
    try {
      const api = getDockerApi()
      if (!api) {
        throw new Error('Electron preload API is unavailable. Launch the Electron app to access Docker.')
      }
      const newPlan = await api.createPlan(sourceHost, targetHost, selection, options)
      setPlan(newPlan)
    } catch (error) {
      setResult({
        ok: false,
        message: 'Failed to generate migration plan.',
        logs: [error instanceof Error ? error.message : 'Unknown error'],
      })
    } finally {
      setIsBusy(false)
    }
  }

  const handleRunMigration = async () => {
    setIsBusy(true)
    setResult(null)
    try {
      const api = getDockerApi()
      if (!api) {
        throw new Error('Electron preload API is unavailable. Launch the Electron app to access Docker.')
      }
      const migrationResult = await api.runMigration(
        sourceHost,
        targetHost,
        selection,
        options,
      )
      setResult(migrationResult)
    } catch (error) {
      setResult({
        ok: false,
        message: 'Migration failed to start.',
        logs: [error instanceof Error ? error.message : 'Unknown error'],
      })
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div>
          <p className="eyebrow">Docker Copy</p>
          <h1>Clone containers, volumes, and networks</h1>
          <p className="subtitle">Use rsync + SSH to migrate Docker assets between hosts.</p>
        </div>
        <div className="status">
          <span className={isBusy ? 'pill busy' : 'pill'}>{isBusy ? 'Working…' : 'Idle'}</span>
        </div>
      </header>

      <section className="grid">
        <div className="card">
          <h2>Source host</h2>
          <p className="hint">Use the local Docker daemon on this machine.</p>
          <label className="inline">
            <input
              type="checkbox"
              checked={useLocalSource}
              onChange={(event) => {
                const nextValue = event.target.checked
                setUseLocalSource(nextValue)
                if (nextValue) {
                  setSourceHost({})
                }
                setSourceTest(null)
              }}
            />
            Use local Docker as source
          </label>
          <div className="form-grid">
            <label>
              Host
              <input
                value={sourceHost.host ?? ''}
                onChange={(event) => setSourceHost({ ...sourceHost, host: event.target.value })}
                disabled={useLocalSource}
                placeholder="192.168.1.10"
              />
            </label>
            <label>
              User
              <input
                value={sourceHost.user ?? ''}
                onChange={(event) => setSourceHost({ ...sourceHost, user: event.target.value })}
                disabled={useLocalSource}
                placeholder="ubuntu"
              />
            </label>
            <label>
              Port
              <input
                type="number"
                value={sourceHost.port ?? ''}
                onChange={(event) =>
                  setSourceHost({
                    ...sourceHost,
                    port: event.target.value ? Number(event.target.value) : undefined,
                  })
                }
                disabled={useLocalSource}
                placeholder="22"
              />
            </label>
            <label>
              Identity file
              <input
                value={sourceHost.identityFile ?? ''}
                onChange={(event) =>
                  setSourceHost({ ...sourceHost, identityFile: event.target.value })
                }
                disabled={useLocalSource}
                placeholder="~/.ssh/id_rsa"
              />
            </label>
          </div>
          <div className="inline-actions">
            <button
              onClick={() =>
                handleTestConnection(useLocalSource ? {} : sourceHost, setSourceTest)
              }
              disabled={isBusy || !canTestSource}
            >
              Test connection
            </button>
          </div>
          {sourceTest && (
            <div className="test-result">
              <p className={sourceTest.ok ? 'success' : 'error'}>{sourceTest.message}</p>
              {sourceTest.logs.length > 0 && <pre>{sourceTest.logs.join('\n')}</pre>}
            </div>
          )}
        </div>

        <div className="card">
          <h2>Target host</h2>
          <p className="hint">Set the SSH destination for rsync and remote Docker operations.</p>
          <div className="form-grid">
            <label>
              Host
              <input
                value={targetHost.host ?? ''}
                onChange={(event) => setTargetHost({ ...targetHost, host: event.target.value })}
                placeholder="192.168.1.20"
              />
            </label>
            <label>
              User
              <input
                value={targetHost.user ?? ''}
                onChange={(event) => setTargetHost({ ...targetHost, user: event.target.value })}
                placeholder="ubuntu"
              />
            </label>
            <label>
              Port
              <input
                type="number"
                value={targetHost.port ?? ''}
                onChange={(event) =>
                  setTargetHost({
                    ...targetHost,
                    port: event.target.value ? Number(event.target.value) : undefined,
                  })
                }
                placeholder="22"
              />
            </label>
            <label>
              Identity file
              <input
                value={targetHost.identityFile ?? ''}
                onChange={(event) =>
                  setTargetHost({ ...targetHost, identityFile: event.target.value })
                }
                placeholder="~/.ssh/id_rsa"
              />
            </label>
          </div>
          <div className="inline-actions">
            <button
              onClick={() => handleTestConnection(targetHost, setTargetTest)}
              disabled={isBusy || !canTestTarget}
            >
              Test connection
            </button>
          </div>
          {targetTest && (
            <div className="test-result">
              <p className={targetTest.ok ? 'success' : 'error'}>{targetTest.message}</p>
              {targetTest.logs.length > 0 && <pre>{targetTest.logs.join('\n')}</pre>}
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <div className="section-header">
          <div>
            <h2>Inventory</h2>
            <p className="hint">Load containers, volumes, and networks from the source host.</p>
          </div>
          <button onClick={handleLoadInventory} disabled={isBusy}>
            Load inventory
          </button>
        </div>

        <div className="inventory-grid">
          <div>
            <h3>Containers</h3>
            {inventory.containers.map((container) => (
              <label key={container.id} className="list-item">
                <input
                  type="checkbox"
                  checked={selection.containers.includes(container.name)}
                  onChange={(event) => {
                    setSelection((prev) => ({
                      ...prev,
                      containers: event.target.checked
                        ? [...prev.containers, container.name]
                        : prev.containers.filter((item) => item !== container.name),
                    }))
                  }}
                />
                <span>
                  <strong>{container.name}</strong>
                  <span className="meta">{container.image}</span>
                  <span className="meta">{container.status}</span>
                </span>
              </label>
            ))}
          </div>
          <div>
            <h3>Volumes</h3>
            {inventory.volumes.map((volume) => (
              <label key={volume.name} className="list-item">
                <input
                  type="checkbox"
                  checked={selection.volumes.includes(volume.name)}
                  onChange={(event) => {
                    setSelection((prev) => ({
                      ...prev,
                      volumes: event.target.checked
                        ? [...prev.volumes, volume.name]
                        : prev.volumes.filter((item) => item !== volume.name),
                    }))
                  }}
                />
                <span>
                  <strong>{volume.name}</strong>
                  <span className="meta">Driver: {volume.driver}</span>
                </span>
              </label>
            ))}
          </div>
          <div>
            <h3>Networks</h3>
            {inventory.networks.map((network) => (
              <label key={network.id} className="list-item">
                <input
                  type="checkbox"
                  checked={selection.networks.includes(network.name)}
                  onChange={(event) => {
                    setSelection((prev) => ({
                      ...prev,
                      networks: event.target.checked
                        ? [...prev.networks, network.name]
                        : prev.networks.filter((item) => item !== network.name),
                    }))
                  }}
                />
                <span>
                  <strong>{network.name}</strong>
                  <span className="meta">Driver: {network.driver}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Options</h2>
        <div className="options">
          <label>
            <input
              type="checkbox"
              checked={options.includeContainers}
              onChange={(event) =>
                setOptions((prev) => ({ ...prev, includeContainers: event.target.checked }))
              }
            />
            Include containers
          </label>
          <label>
            <input
              type="checkbox"
              checked={options.includeVolumes}
              onChange={(event) =>
                setOptions((prev) => ({ ...prev, includeVolumes: event.target.checked }))
              }
            />
            Include volumes
          </label>
          <label>
            <input
              type="checkbox"
              checked={options.includeNetworks}
              onChange={(event) =>
                setOptions((prev) => ({ ...prev, includeNetworks: event.target.checked }))
              }
            />
            Include networks
          </label>
          <label>
            <input
              type="checkbox"
              checked={options.dryRun}
              onChange={(event) =>
                setOptions((prev) => ({ ...prev, dryRun: event.target.checked }))
              }
            />
            Dry run
          </label>
        </div>
        <div className="actions">
          <button onClick={handleCreatePlan} disabled={isBusy || isSelectionEmpty}>
            Generate plan
          </button>
          <button
            onClick={handleRunMigration}
            disabled={isBusy || isSelectionEmpty || options.dryRun}
            className="primary"
          >
            Run migration
          </button>
        </div>
        <p className="hint">Disable dry run to execute volume/network migrations.</p>
      </section>

      <section className="grid">
        <div className="card">
          <h2>Plan</h2>
          {plan ? (
            <>
              {plan.warnings.length > 0 && (
                <ul className="warnings">
                  {plan.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
              <ol className="steps">
                {plan.steps.map((step) => (
                  <li key={step.id}>
                    <span>{step.label}</span>
                    {step.command && <code>{step.command}</code>}
                    {step.runOn && <span className="meta">Run on: {step.runOn}</span>}
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="hint">Generate a plan to preview migration steps.</p>
          )}
        </div>

        <div className="card">
          <h2>Execution log</h2>
          {result ? (
            <>
              <p className={result.ok ? 'success' : 'error'}>{result.message}</p>
              <pre>{result.logs.join('\n')}</pre>
            </>
          ) : (
            <p className="hint">Run a migration to capture logs.</p>
          )}
        </div>
      </section>
    </div>
  )
}

export default App
