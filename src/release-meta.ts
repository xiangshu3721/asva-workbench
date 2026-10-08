export interface ReleaseMetadataSnapshot {
  release?: string
  releaseCounter?: number
  gitCommit?: string
  buildTime?: string | null
  environment?: string
}

export function releaseVersion(metadata: ReleaseMetadataSnapshot | null | undefined) {
  return typeof metadata?.release === 'string' && metadata.release ? metadata.release : 'UNKNOWN'
}

export function releasesMatch(frontend: ReleaseMetadataSnapshot | null | undefined, backend: ReleaseMetadataSnapshot | null | undefined) {
  const frontendCounter = Number(frontend?.releaseCounter)
  const backendCounter = Number(backend?.releaseCounter)
  return Number.isFinite(frontendCounter) && Number.isFinite(backendCounter) ? frontendCounter === backendCounter : null
}
