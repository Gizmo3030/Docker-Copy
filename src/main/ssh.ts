import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { HostConfig } from '../shared/types'

const execFileAsync = promisify(execFile)

export interface CommandResult {
  stdout: string
  stderr: string
}

export async function runLocalCommand(command: string, args: string[]): Promise<CommandResult> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  })
  return { stdout, stderr }
}

export function buildSshArgs(host: HostConfig, remoteCommand: string): string[] {
  if (!host.host || !host.user) {
    throw new Error('Remote host and user are required for SSH commands.')
  }
  const args: string[] = []
  if (host.port) {
    args.push('-p', String(host.port))
  }
  if (host.identityFile) {
    args.push('-i', host.identityFile)
  }
  args.push(`${host.user}@${host.host}`)
  args.push('--', remoteCommand)
  return args
}

export async function runRemoteCommand(host: HostConfig, remoteCommand: string): Promise<CommandResult> {
  const args = buildSshArgs(host, remoteCommand)
  return runLocalCommand('ssh', args)
}

export function isRemoteHost(host: HostConfig): boolean {
  return Boolean(host.host && host.user)
}
