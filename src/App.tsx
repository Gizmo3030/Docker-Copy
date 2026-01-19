import { useEffect, useMemo, useState } from 'react'
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
  const [showAdvancedWarnings, setShowAdvancedWarnings] = useState(false)
  const [progress, setProgress] = useState<{ current: number; total: number; message: string } | null>(
    null,
  )

  const getDockerApi = () => {
    if (!window.dockerCopy) {
      return null
    }
    return window.dockerCopy
  }

  const getPreloadDiagnostics = () => {
    const isElectron = typeof navigator !== 'undefined' && /Electron/.test(navigator.userAgent)
    const meta = window.dockerCopyMeta
    return [
      `Renderer: ${isElectron ? 'electron' : 'browser'}`,
      `Location: ${window.location.href}`,
      `User agent: ${navigator.userAgent}`,
      `Preload meta: ${meta?.preloadLoaded ? 'loaded' : 'missing'}`,
      meta?.versions?.electron ? `Electron: ${meta.versions.electron}` : 'Electron: unknown',
      meta?.platform ? `Platform: ${meta.platform}` : 'Platform: unknown',
    ]
  }

  useEffect(() => {
    if (!window.dockerCopy?.onMigrationProgress) {
      return
    }
    const unsubscribe = window.dockerCopy.onMigrationProgress((update) => {
      setProgress(update)
    })
    return unsubscribe
  }, [])

  const isSelectionEmpty = useMemo(
    () =>
      selection.containers.length === 0 &&
      selection.volumes.length === 0 &&
      selection.networks.length === 0,
    [selection],
  )

  const inventoryRelations = useMemo(() => {
    const attachedVolumeNames = new Set<string>()
    const attachedNetworkNames = new Set<string>()

    inventory.containers.forEach((container) => {
      container.volumes.forEach((volume) => attachedVolumeNames.add(volume))
      container.networks.forEach((network) => attachedNetworkNames.add(network))
    })

    const orphanVolumes = inventory.volumes.filter(
      (volume) => !attachedVolumeNames.has(volume.name),
    )
    const orphanNetworks = inventory.networks.filter(
      (network) => !attachedNetworkNames.has(network.name),
    )

    return { orphanVolumes, orphanNetworks }
  }, [inventory])

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
        throw new Error(
          'Electron preload API is unavailable. Restart the Electron app and ensure the preload script is loading.',
        )
      }
      const testResult = await api.testConnection(host)
      setTest(testResult)
    } catch (error) {
      const diagnostics = getPreloadDiagnostics()
      setTest({
        ok: false,
        message: 'Connection test failed to start.',
        logs: [error instanceof Error ? error.message : 'Unknown error', ...diagnostics],
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
        throw new Error(
          'Electron preload API is unavailable. Restart the Electron app and ensure the preload script is loading.',
        )
      }
      const data = await api.listInventory(sourceHost)
      setInventory(data)
      setSelection({ containers: [], volumes: [], networks: [] })
    } catch (error) {
      const diagnostics = getPreloadDiagnostics()
      setResult({
        ok: false,
        message: 'Failed to load inventory.',
        logs: [error instanceof Error ? error.message : 'Unknown error', ...diagnostics],
      })
    } finally {
      setIsBusy(false)
    }
  }

  const handleCreatePlan = async () => {
    setIsBusy(true)
    setResult(null)
    setProgress(null)
    try {
      const api = getDockerApi()
      if (!api) {
        throw new Error(
          'Electron preload API is unavailable. Restart the Electron app and ensure the preload script is loading.',
        )
      }
      const newPlan = await api.createPlan(sourceHost, targetHost, selection, options)
      setPlan(newPlan)
      setShowAdvancedWarnings(false)
    } catch (error) {
        const diagnostics = getPreloadDiagnostics()
      setResult({
        ok: false,
        message: 'Failed to generate migration plan.',
          logs: [error instanceof Error ? error.message : 'Unknown error', ...diagnostics],
      })
    } finally {
      setIsBusy(false)
    }
  }

  const handleRunMigration = async () => {
    setIsBusy(true)
    setResult(null)
    setProgress(null)
    try {
      const api = getDockerApi()
      if (!api) {
        throw new Error(
          'Electron preload API is unavailable. Restart the Electron app and ensure the preload script is loading.',
        )
      }
      const migrationResult = await api.runMigration(
        sourceHost,
        targetHost,
        selection,
        options,
      )
      setResult(migrationResult)
    } catch (error) {
      const diagnostics = getPreloadDiagnostics()
      setResult({
        ok: false,
        message: 'Migration failed to start.',
        logs: [error instanceof Error ? error.message : 'Unknown error', ...diagnostics],
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

      {isBusy && (
        <div className="progress" role="progressbar" aria-label="Migration progress" aria-busy="true">
          <div
            className="progress-bar"
            style={{ width: progress ? `${Math.min(100, (progress.current / progress.total) * 100)}%` : '35%' }}
          />
          <div className="progress-meta">
            <span>{progress ? `${progress.current}/${progress.total}` : 'Working…'}</span>
            <span>{progress?.message ?? 'Initializing'}</span>
          </div>
        </div>
      )}

      {!window.dockerCopy && (
        <section className="card">
          <h2>Preload not detected</h2>
          <p className="hint">
            The renderer cannot access the Electron preload API. Make sure you started the
            Electron app (not just the Vite dev server) and restart after changes.
          </p>
          <pre>{getPreloadDiagnostics().join('\n')}</pre>
        </section>
      )}

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

        <div className="inventory-table" role="table" aria-label="Container inventory">
          <div className="inventory-row inventory-header" role="row">
            <span className="inventory-cell" role="columnheader">
              Containers
            </span>
            <span className="inventory-cell" role="columnheader">
              Volumes
            </span>
            <span className="inventory-cell" role="columnheader">
              Networks
            </span>
          </div>
          {inventory.containers.map((container) => (
            <div key={container.id} className="inventory-row" role="row">
              <div className="inventory-cell" role="cell">
                <label className="list-item">
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
              </div>
              <div className="inventory-cell" role="cell">
                {container.volumes.length ? (
                  <div className="tag-list">
                    {container.volumes.map((volume) => (
                      <label key={volume} className="tag selectable">
                        <input
                          type="checkbox"
                          checked={selection.volumes.includes(volume)}
                          onChange={(event) => {
                            setSelection((prev) => ({
                              ...prev,
                              volumes: event.target.checked
                                ? [...prev.volumes, volume]
                                : prev.volumes.filter((item) => item !== volume),
                            }))
                          }}
                        />
                        {volume}
                      </label>
                    ))}
                  </div>
                ) : (
                  <span className="muted">No volumes</span>
                )}
              </div>
              <div className="inventory-cell" role="cell">
                {container.networks.length ? (
                  <div className="tag-list">
                    {container.networks.map((network) => (
                      <label key={network} className="tag selectable">
                        <input
                          type="checkbox"
                          checked={selection.networks.includes(network)}
                          onChange={(event) => {
                            setSelection((prev) => ({
                              ...prev,
                              networks: event.target.checked
                                ? [...prev.networks, network]
                                : prev.networks.filter((item) => item !== network),
                            }))
                          }}
                        />
                        {network}
                      </label>
                    ))}
                  </div>
                ) : (
                  <span className="muted">No networks</span>
                )}
              </div>
            </div>
          ))}

          {(inventoryRelations.orphanVolumes.length > 0 ||
            inventoryRelations.orphanNetworks.length > 0) && (
            <div className="inventory-row orphan-row" role="row">
              <div className="inventory-cell" role="cell">
                <strong>Unattached</strong>
                <span className="meta">Items not linked to a container</span>
              </div>
              <div className="inventory-cell" role="cell">
                {inventoryRelations.orphanVolumes.length ? (
                  <div className="tag-list">
                    {inventoryRelations.orphanVolumes.map((volume) => (
                      <label key={volume.name} className="tag selectable">
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
                        {volume.name}
                      </label>
                    ))}
                  </div>
                ) : (
                  <span className="muted">No unattached volumes</span>
                )}
              </div>
              <div className="inventory-cell" role="cell">
                {inventoryRelations.orphanNetworks.length ? (
                  <div className="tag-list">
                    {inventoryRelations.orphanNetworks.map((network) => (
                      <label key={network.id} className="tag selectable">
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
                        {network.name}
                      </label>
                    ))}
                  </div>
                ) : (
                  <span className="muted">No unattached networks</span>
                )}
              </div>
            </div>
          )}
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
                <div className="inline-actions">
                  <label className="inline">
                    <input
                      type="checkbox"
                      checked={showAdvancedWarnings}
                      onChange={(event) => setShowAdvancedWarnings(event.target.checked)}
                    />
                    Show advanced warnings ({plan.warnings.length})
                  </label>
                </div>
              )}
              {plan.warnings.length > 0 && showAdvancedWarnings && (
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
