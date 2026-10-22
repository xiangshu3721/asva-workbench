export interface ReleaseMetadataSnapshot {
  release?: string
  releaseCounter?: number
  releasePatch?: number
  gitCommit?: string
  buildTime?: string | null
  environment?: string
}

export function releaseVersion(metadata: ReleaseMetadataSnapshot | null | undefined) {
  return typeof metadata?.release === 'string' && metadata.release ? metadata.release : 'UNKNOWN'
}

export function releasesMatch(frontend: ReleaseMetadataSnapshot | null | undefined, backend: ReleaseMetadataSnapshot | null | undefined) {
  const frontendRelease = releaseVersion(frontend)
  const backendRelease = releaseVersion(backend)
  if (frontendRelease !== 'UNKNOWN' && backendRelease !== 'UNKNOWN') return frontendRelease === backendRelease
  const frontendCounter = Number(frontend?.releaseCounter)
  const backendCounter = Number(backend?.releaseCounter)
  return Number.isFinite(frontendCounter) && Number.isFinite(backendCounter) ? frontendCounter === backendCounter : null
}
