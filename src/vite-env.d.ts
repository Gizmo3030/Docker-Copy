/// <reference types="vite/client" />

import type { DockerCopyApi } from './shared/types'

declare global {
  interface Window {
    dockerCopy: DockerCopyApi
    dockerCopyMeta?: {
      preloadLoaded: boolean
      versions: Record<string, string>
      platform: string
    }
  }
}
