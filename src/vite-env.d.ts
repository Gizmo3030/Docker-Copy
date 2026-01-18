/// <reference types="vite/client" />

import type { DockerCopyApi } from './shared/types'

declare global {
  interface Window {
    dockerCopy: DockerCopyApi
  }
}
