import type {
  ConnectionTestResult,
  DockerContainerInfo,
  DockerNetworkInfo,
  DockerVolumeInfo,
  HostConfig,
} from '../shared/types'
import { isRemoteHost, runLocalCommand, runRemoteCommand } from './ssh.js'

async function runDockerCommand(host: HostConfig, args: string[]): Promise<string> {
  const command = ['docker', ...args].join(' ')
  if (isRemoteHost(host)) {
    const { stdout } = await runRemoteCommand(host, command)
    return stdout
  }
  const { stdout } = await runLocalCommand('docker', args)
  return stdout
}

function parseJsonLines<T>(output: string): T[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

export async function listContainers(host: HostConfig): Promise<DockerContainerInfo[]> {
  const output = await runDockerCommand(host, ['ps', '-a', '--format', '{{json .}}'])
  return parseJsonLines<{ ID: string; Names: string; Image: string; Status: string }>(output).map(
    (item) => ({
      id: item.ID,
      name: item.Names,
      image: item.Image,
      status: item.Status,
    }),
  )
}

export async function listVolumes(host: HostConfig): Promise<DockerVolumeInfo[]> {
  const output = await runDockerCommand(host, ['volume', 'ls', '--format', '{{json .}}'])
  return parseJsonLines<{ Name: string; Driver: string }>(output).map((item) => ({
    name: item.Name,
    driver: item.Driver,
  }))
}

export async function listNetworks(host: HostConfig): Promise<DockerNetworkInfo[]> {
  const output = await runDockerCommand(host, ['network', 'ls', '--format', '{{json .}}'])
  return parseJsonLines<{ ID: string; Name: string; Driver: string }>(output).map((item) => ({
    id: item.ID,
    name: item.Name,
    driver: item.Driver,
  }))
}

export async function inspectContainers(host: HostConfig, names: string[]): Promise<string> {
  if (!names.length) {
    return ''
  }
  return runDockerCommand(host, ['inspect', ...names])
}

export async function inspectVolumes(host: HostConfig, names: string[]): Promise<string> {
  if (!names.length) {
    return ''
  }
  return runDockerCommand(host, ['volume', 'inspect', ...names])
}

export async function testDockerConnection(host: HostConfig): Promise<ConnectionTestResult> {
  const logs: string[] = []
  try {
    if (isRemoteHost(host)) {
      const { stdout: sshStdout } = await runRemoteCommand(host, 'echo connected')
      const sshMessage = sshStdout.trim() || 'connected'
      logs.push(`SSH: ${sshMessage}`)

      const { stdout: dockerStdout } = await runRemoteCommand(
        host,
        'docker version --format "{{.Server.Version}}"',
      )
      const version = dockerStdout.trim()
      if (!version) {
        throw new Error('Docker daemon responded with an empty version string.')
      }
      logs.push(`Docker Server: ${version}`)
    } else {
      const { stdout: dockerStdout } = await runLocalCommand('docker', [
        'version',
        '--format',
        '{{.Server.Version}}',
      ])
      const version = dockerStdout.trim()
      if (!version) {
        throw new Error('Docker daemon responded with an empty version string.')
      }
      logs.push(`Docker Server: ${version}`)
    }

    return {
      ok: true,
      message: 'Connection successful.',
      logs,
    }
  } catch (error) {
    logs.push(error instanceof Error ? error.message : 'Unknown error')
    return {
      ok: false,
      message: 'Connection failed.',
      logs,
    }
  }
}
