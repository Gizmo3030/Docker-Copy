import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import type {
  HostConfig,
  MigrationOptions,
  MigrationPlan,
  MigrationPlanStep,
  MigrationResult,
  MigrationSelection,
} from '../shared/types'
import { inspectContainers, inspectVolumes } from './docker.js'
import { buildSshArgs, isRemoteHost, runLocalCommand, runRemoteCommand } from './ssh.js'

const DEFAULT_NETWORKS = new Set(['bridge', 'host', 'none'])

function isDefaultNetwork(name: string): boolean {
  return DEFAULT_NETWORKS.has(name)
}

type ContainerInspect = {
  Name?: string
  Config?: {
    Env?: string[]
    Cmd?: string[]
    Entrypoint?: string[]
    WorkingDir?: string
    User?: string
  }
  HostConfig?: {
    Binds?: string[]
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }>>
    RestartPolicy?: { Name?: string; MaximumRetryCount?: number }
    AutoRemove?: boolean
  }
  NetworkSettings?: {
    Networks?: Record<string, unknown>
  }
  State?: { Running?: boolean; Status?: string }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function buildSshCommandString(host: HostConfig, remoteCommand: string): string {
  if (!host.host || !host.user) {
    throw new Error('Remote host and user are required for SSH commands.')
  }
  const parts: string[] = ['ssh']
  if (host.port) {
    parts.push('-p', String(host.port))
  }
  if (host.identityFile) {
    parts.push('-i', host.identityFile)
  }
  parts.push(`${host.user}@${host.host}`, '--', remoteCommand)
  return parts.map(shellEscape).join(' ')
}

function buildDockerTarArgs(volume: string): string[] {
  return ['run', '--rm', '-v', `${volume}:/from`, 'alpine', 'sh', '-c', 'cd /from && tar -cpf - .']
}

function buildDockerUntarArgs(volume: string): string[] {
  return [
    'run',
    '--rm',
    '-i',
    '-v',
    `${volume}:/to`,
    'alpine',
    'sh',
    '-c',
    'cd /to && rm -rf ./* ./.??* && tar -xpf -',
  ]
}

function buildDockerUntarCommand(volume: string): string {
  return buildDockerCommand(buildDockerUntarArgs(volume))
}

async function runPipedCommands(
  sourceCommand: string,
  sourceArgs: string[],
  targetCommand: string,
  targetArgs: string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const source = spawn(sourceCommand, sourceArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    const target = spawn(targetCommand, targetArgs, { stdio: ['pipe', 'pipe', 'pipe'] })

    source.stdout.pipe(target.stdin)

    let sourceError = ''
    let targetError = ''

    source.stderr.on('data', (chunk) => {
      sourceError += chunk.toString()
    })
    target.stderr.on('data', (chunk) => {
      targetError += chunk.toString()
    })

    source.on('error', (error) => reject(error))
    target.on('error', (error) => reject(error))

    let sourceExit: number | null = null
    let targetExit: number | null = null

    const checkComplete = () => {
      if (sourceExit === null || targetExit === null) {
        return
      }
      if (sourceExit !== 0 || targetExit !== 0) {
        const details = [sourceError.trim(), targetError.trim()].filter(Boolean).join('\n')
        reject(
          new Error(
            `Helper sync failed (source=${sourceExit}, target=${targetExit}).${details ? `\n${details}` : ''}`,
          ),
        )
        return
      }
      resolve()
    }

    source.on('close', (code) => {
      sourceExit = code
      checkComplete()
    })
    target.on('close', (code) => {
      targetExit = code
      checkComplete()
    })
  })
}

async function syncVolumeWithHelper(source: HostConfig, target: HostConfig, name: string): Promise<void> {
  if (isRemoteHost(source)) {
    throw new Error('Helper-container sync requires a local source host.')
  }
  const sourceArgs = buildDockerTarArgs(name)
  if (isRemoteHost(target)) {
    const targetCmd = buildDockerUntarCommand(name)
    const sshArgs = buildSshArgs(target, targetCmd)
    await runPipedCommands('docker', sourceArgs, 'ssh', sshArgs)
    return
  }
  const targetArgs = buildDockerUntarArgs(name)
  await runPipedCommands('docker', sourceArgs, 'docker', targetArgs)
}

function sanitizeImageTag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')
}

function buildDockerCommand(args: string[]): string {
  return `docker ${args.map(shellEscape).join(' ')}`
}

async function runDockerOnTarget(target: HostConfig, args: string[]): Promise<void> {
  if (isRemoteHost(target)) {
    await runRemoteCommand(target, buildDockerCommand(args))
    return
  }
  await runLocalCommand('docker', args)
}

async function rsyncFileToTarget(filePath: string, targetPath: string, target: HostConfig): Promise<void> {
  if (!isRemoteHost(target)) {
    await fs.copyFile(filePath, targetPath)
    return
  }
  const sshArgs = buildSshArgs(target, 'true')
  const sshIndex = sshArgs.findIndex((arg) => arg.includes('@'))
  const sshPrefix = ['ssh', ...sshArgs.slice(0, sshIndex)]
  const remoteHost = sshArgs[sshIndex]
  const rsyncArgs = ['-az', '-e', `${sshPrefix.join(' ')}`, filePath, `${remoteHost}:${targetPath}`]

  try {
    await runLocalCommand('rsync', rsyncArgs)
    return
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code && err.code !== 'ENOENT') {
      throw error
    }
  }

  const scpArgs: string[] = []
  if (target.port) {
    scpArgs.push('-P', String(target.port))
  }
  if (target.identityFile) {
    scpArgs.push('-i', target.identityFile)
  }
  scpArgs.push(filePath, `${target.user}@${target.host}:${targetPath}`)
  await runLocalCommand('scp', scpArgs)
}

function isWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:\\/.test(value) || value.includes('\\')
}

function normalizeBindMount(bind: string): { bind?: string; reason?: string } {
  if (isWindowsPath(bind)) {
    return { reason: 'Windows host path detected' }
  }
  return { bind }
}

function buildContainerRunArgs(
  name: string,
  inspect: ContainerInspect,
  imageTag: string,
): { args: string[]; skippedBinds: string[] } {
  const args: string[] = []
  const skippedBinds: string[] = []
  const isRunning = Boolean(inspect.State?.Running)
  args.push(isRunning ? 'run' : 'create')
  if (isRunning) {
    args.push('-d')
  }
  args.push('--name', name)

  const env = inspect.Config?.Env ?? []
  env.forEach((entry) => args.push('-e', entry))

  const binds = inspect.HostConfig?.Binds ?? []
  binds.forEach((bind) => {
    const { bind: normalized } = normalizeBindMount(bind)
    if (normalized) {
      args.push('-v', normalized)
    } else {
      skippedBinds.push(bind)
    }
  })

  const portBindings = inspect.HostConfig?.PortBindings ?? {}
  Object.entries(portBindings).forEach(([containerPort, bindings]) => {
    if (!bindings?.length) {
      return
    }
    bindings.forEach((binding) => {
      const hostIp = binding.HostIp && binding.HostIp !== '' ? `${binding.HostIp}:` : ''
      const hostPort = binding.HostPort ? `${binding.HostPort}:` : ''
      args.push('-p', `${hostIp}${hostPort}${containerPort}`)
    })
  })

  const restart = inspect.HostConfig?.RestartPolicy
  if (restart?.Name && restart.Name !== 'no') {
    const policy = restart.Name === 'on-failure' && restart.MaximumRetryCount
      ? `on-failure:${restart.MaximumRetryCount}`
      : restart.Name
    args.push(`--restart=${policy}`)
  }

  const networkNames = Object.keys(inspect.NetworkSettings?.Networks ?? {})
  const nonDefaultNetwork = networkNames.find((network) => !isDefaultNetwork(network))
  if (nonDefaultNetwork) {
    args.push('--network', nonDefaultNetwork)
  }

  if (inspect.Config?.WorkingDir) {
    args.push('-w', inspect.Config.WorkingDir)
  }
  if (inspect.Config?.User) {
    args.push('-u', inspect.Config.User)
  }
  if (inspect.Config?.Entrypoint?.length) {
    args.push('--entrypoint', inspect.Config.Entrypoint.join(' '))
  }

  args.push(imageTag)
  if (inspect.Config?.Cmd?.length) {
    args.push(...inspect.Config.Cmd)
  }

  return { args, skippedBinds }
}

function createStep(label: string, command?: string, runOn?: 'source' | 'target' | 'local'): MigrationPlanStep {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label,
    command,
    runOn,
  }
}

export async function createMigrationPlan(
  source: HostConfig,
  target: HostConfig,
  selection: MigrationSelection,
  options: MigrationOptions,
): Promise<MigrationPlan> {
  const steps: MigrationPlanStep[] = []
  const warnings: string[] = []

  if (options.includeNetworks && selection.networks.length) {
    for (const network of selection.networks) {
      if (isDefaultNetwork(network)) {
        warnings.push(
          `Skipping default network "${network}". Predefined Docker networks are not created manually.`,
        )
        continue
      }
      steps.push(
        createStep(`Create network ${network} on target`, `docker network create ${network}`, 'target'),
      )
    }
  }

  if (options.includeVolumes && selection.volumes.length) {
    warnings.push('Volume sync uses a helper container (alpine) and does not require sudo.')
    for (const volume of selection.volumes) {
      steps.push(
        createStep(`Ensure volume ${volume} exists on target`, `docker volume create ${volume}`, 'target'),
      )
      steps.push(
        createStep(
          `Sync volume ${volume} data to target (helper container)`,
          `docker run --rm -v ${volume}:/from alpine sh -c "tar -cpf - -C /from ." | ssh <target> docker run --rm -i -v ${volume}:/to alpine sh -c "tar -xpf - -C /to"`,
          'local',
        ),
      )
    }
  }

  if (options.includeContainers && selection.containers.length) {
    warnings.push('Containers are recreated with a best-effort config. Review runtime settings after migration.')
    for (const container of selection.containers) {
      steps.push(
        createStep(
          `Commit container ${container} to an image on source`,
          `docker commit ${container} ${container}:migrated`,
          'source',
        ),
      )
      steps.push(
        createStep(
          `Save image ${container}:migrated to tar`,
          `docker save ${container}:migrated -o ${container}-image.tar`,
          'source',
        ),
      )
      steps.push(
        createStep(
          `Transfer image tar to target`,
          `rsync -az -e "ssh" ${container}-image.tar <targetHost>:~/`,
          'local',
        ),
      )
      steps.push(
        createStep(
          `Load image on target`,
          `docker load -i ~/${container}-image.tar`,
          'target',
        ),
      )
      steps.push(
        createStep(
          `Recreate container ${container} on target`,
          `docker run --name ${container} ${container}:migrated`,
          'target',
        ),
      )
    }
  }

  if (!steps.length) {
    warnings.push('Select at least one container, volume, or network to migrate.')
  }

  return { steps, warnings }
}

async function getVolumeMountpoint(host: HostConfig, name: string): Promise<string> {
  const output = isRemoteHost(host)
    ? await runRemoteCommand(host, `docker volume inspect -f '{{ .Mountpoint }}' ${name}`)
    : await runLocalCommand('docker', ['volume', 'inspect', '-f', '{{ .Mountpoint }}', name])
  return output.stdout.trim()
}

async function ensureVolumeOnTarget(target: HostConfig, name: string): Promise<void> {
  if (isRemoteHost(target)) {
    await runRemoteCommand(target, `docker volume create ${name}`)
  } else {
    await runLocalCommand('docker', ['volume', 'create', name])
  }
}

async function ensureNetworkOnTarget(target: HostConfig, name: string): Promise<void> {
  if (isRemoteHost(target)) {
    await runRemoteCommand(target, `docker network create ${name}`)
  } else {
    await runLocalCommand('docker', ['network', 'create', name])
  }
}

function isPermissionDenied(error: unknown): boolean {
  if (error instanceof Error && /permission denied/i.test(error.message)) {
    return true
  }
  const stderr = (error as { stderr?: string }).stderr
  return typeof stderr === 'string' && /permission denied/i.test(stderr)
}

async function rsyncDirectory(
  sourcePath: string,
  targetPath: string,
  target: HostConfig,
  forceSudo = false,
): Promise<void> {
  const needsSudoSource = forceSudo || sourcePath.startsWith('/var/lib/docker/volumes')
  const needsSudoTarget = forceSudo || targetPath.startsWith('/var/lib/docker/volumes')

  if (isRemoteHost(target)) {
    const sshArgs = buildSshArgs(target, 'true')
    const sshIndex = sshArgs.findIndex((arg) => arg.includes('@'))
    const sshPrefix = ['ssh', ...sshArgs.slice(0, sshIndex)]
    const remoteHost = sshArgs[sshIndex]

    const args = [
      '-az',
      '--delete',
      '-e',
      `${sshPrefix.join(' ')}`,
      ...(needsSudoTarget ? ['--rsync-path', 'sudo -n rsync'] : []),
      `${sourcePath}/`,
      `${remoteHost}:${targetPath}/`,
    ]
    if (needsSudoSource) {
      await runLocalCommand('sudo', ['-n', 'rsync', ...args])
      return
    }
    await runLocalCommand('rsync', args)
    return
  }

  const localArgs = ['-az', '--delete', `${sourcePath}/`, `${targetPath}/`]
  if (needsSudoSource || needsSudoTarget) {
    await runLocalCommand('sudo', ['-n', 'rsync', ...localArgs])
    return
  }
  await runLocalCommand('rsync', localArgs)
}

export async function runMigration(
  event: IpcMainInvokeEvent,
  source: HostConfig,
  target: HostConfig,
  selection: MigrationSelection,
  options: MigrationOptions,
): Promise<MigrationResult> {
  const logs: string[] = []

  const totalSteps =
    (options.includeNetworks
      ? selection.networks.filter((name) => !isDefaultNetwork(name)).length
      : 0) +
    (options.includeVolumes ? selection.volumes.length : 0) +
    (options.includeContainers ? selection.containers.length * 5 : 0)

  let current = 0
  const reportProgress = (message: string) => {
    current += 1
    event.sender.send('migration:progress', {
      current,
      total: Math.max(totalSteps, 1),
      message,
    })
  }

  if (options.includeNetworks) {
    for (const network of selection.networks) {
      if (isDefaultNetwork(network)) {
        logs.push(`Skipping default network ${network} (predefined by Docker).`)
        continue
      }
      reportProgress(`Creating network ${network} on target`)
      logs.push(`Creating network ${network} on target`)
      await ensureNetworkOnTarget(target, network)
    }
  }

  if (options.includeVolumes) {
    if (isRemoteHost(source)) {
      return {
        ok: false,
        message: 'Remote source volume sync is not implemented. Use a local source host for volumes.',
        logs,
      }
    }

    for (const volume of selection.volumes) {
      reportProgress(`Syncing volume ${volume} to target`)
      logs.push(`Preparing volume ${volume} on target`)
      await ensureVolumeOnTarget(target, volume)
      logs.push('Syncing volume data via helper container stream.')
      await syncVolumeWithHelper(source, target, volume)
    }
  }

  if (options.includeContainers) {
    if (isRemoteHost(source)) {
      return {
        ok: false,
        message: 'Automated container migration requires a local source host for now.',
        logs,
      }
    }

    const containerInspectRaw = await inspectContainers(source, selection.containers)
    const containerInspect = JSON.parse(containerInspectRaw) as ContainerInspect[]
    const inspectByName = new Map(
      containerInspect
        .map((item) => [item.Name?.replace(/^\//, ''), item] as const)
        .filter(([name]) => Boolean(name)),
    )

    for (const container of selection.containers) {
      reportProgress(`Committing ${container}`)
      const inspect = inspectByName.get(container)
      if (!inspect) {
        logs.push(`Skipping ${container}: unable to read container configuration.`)
        continue
      }

      const imageTag = `docker-copy/${sanitizeImageTag(container)}:migrated`
      const tarName = `${sanitizeImageTag(container)}-${Date.now()}.tar`
      const localTar = path.join(os.tmpdir(), tarName)
      const targetTar = isRemoteHost(target) ? `/tmp/${tarName}` : localTar

      logs.push(`Committing ${container} to ${imageTag}`)
      await runLocalCommand('docker', ['commit', container, imageTag])

      reportProgress(`Saving image ${container}`)
      logs.push(`Saving ${imageTag} to ${localTar}`)
      await runLocalCommand('docker', ['save', imageTag, '-o', localTar])

      reportProgress(`Transferring image ${container}`)
      logs.push(`Transferring image tar to target`)
      await rsyncFileToTarget(localTar, targetTar, target)

      reportProgress(`Loading image ${container} on target`)
      logs.push(`Loading image ${imageTag} on target`)
      await runDockerOnTarget(target, ['load', '-i', targetTar])

      reportProgress(`Creating container ${container} on target`)
      logs.push(`Creating container ${container} on target`)
      const { args: runArgs, skippedBinds } = buildContainerRunArgs(container, inspect, imageTag)
      if (skippedBinds.length > 0) {
        logs.push(
          `Skipped ${skippedBinds.length} bind mount(s) with Windows paths for ${container}. Update mounts manually on the target.`,
        )
        logs.push(`Skipped mounts: ${skippedBinds.join(', ')}`)
      }
      await runDockerOnTarget(target, runArgs)

      try {
        await fs.unlink(localTar)
      } catch {
        // ignore cleanup errors
      }

      if (isRemoteHost(target)) {
        try {
          await runRemoteCommand(target, `rm -f ${shellEscape(targetTar)}`)
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  if (options.includeVolumes) {
    const volumeInspect = await inspectVolumes(source, selection.volumes)
    logs.push('Volume inspection data captured.')
    logs.push(volumeInspect)
  }

  return {
    ok: true,
    message: options.includeContainers
      ? 'Migration finished with container steps pending manual execution.'
      : 'Migration finished successfully.',
    logs,
  }
}
