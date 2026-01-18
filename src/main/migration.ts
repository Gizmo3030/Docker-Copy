import type { HostConfig, MigrationOptions, MigrationPlan, MigrationPlanStep, MigrationResult, MigrationSelection } from '../shared/types'
import { inspectContainers, inspectVolumes } from './docker.js'
import { buildSshArgs, isRemoteHost, runLocalCommand, runRemoteCommand } from './ssh.js'

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
      steps.push(
        createStep(`Create network ${network} on target`, `docker network create ${network}`, 'target'),
      )
    }
  }

  if (options.includeVolumes && selection.volumes.length) {
    for (const volume of selection.volumes) {
      steps.push(
        createStep(`Ensure volume ${volume} exists on target`, `docker volume create ${volume}`, 'target'),
      )
      steps.push(
        createStep(
          `Sync volume ${volume} data to target`,
          `rsync -az --delete <sourceMountpoint>/ <targetMountpoint>/`,
          'local',
        ),
      )
    }
  }

  if (options.includeContainers && selection.containers.length) {
    warnings.push('Container runtime configuration recreation is not yet automated.')
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

async function rsyncDirectory(sourcePath: string, targetPath: string, target: HostConfig): Promise<void> {
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
      `${sourcePath}/`,
      `${remoteHost}:${targetPath}/`,
    ]
    await runLocalCommand('rsync', args)
    return
  }

  await runLocalCommand('rsync', ['-az', '--delete', `${sourcePath}/`, `${targetPath}/`])
}

export async function runMigration(
  source: HostConfig,
  target: HostConfig,
  selection: MigrationSelection,
  options: MigrationOptions,
): Promise<MigrationResult> {
  const logs: string[] = []

  if (options.includeNetworks) {
    for (const network of selection.networks) {
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
      logs.push(`Preparing volume ${volume} on target`)
      await ensureVolumeOnTarget(target, volume)
      const sourceMount = await getVolumeMountpoint(source, volume)
      const targetMount = await getVolumeMountpoint(target, volume)
      logs.push(`Syncing ${sourceMount} -> ${targetMount}`)
      await rsyncDirectory(sourceMount, targetMount, target)
    }
  }

  if (options.includeContainers) {
    const containerInspect = await inspectContainers(source, selection.containers)
    logs.push('Container inspection data captured.')
    logs.push(containerInspect)
    logs.push('Container migration execution is not automated yet. Use the plan as a guide.')
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
