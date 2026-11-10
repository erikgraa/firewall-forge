import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const DAY = 24 * 60 * 60 * 1000
const DIGEST = /^sha256:[a-f0-9]{64}$/
const INDEX_TYPES = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']
const IMAGE_TYPES = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']
const ACCEPT = [...INDEX_TYPES, ...IMAGE_TYPES].join(', ')

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function timestamp(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)), 'Invalid version timestamp')
  return Date.parse(value)
}

function validateVersions(versions) {
  const ids = new Set()
  const digests = new Set()
  for (const version of versions) {
    requireValue(Number.isSafeInteger(version.id) && version.id > 0 && !ids.has(version.id), 'Invalid or duplicate version ID')
    requireValue(typeof version.name === 'string' && DIGEST.test(version.name) && !digests.has(version.name), 'Invalid or duplicate version digest')
    requireValue(version.metadata?.package_type === 'container' && Array.isArray(version.metadata?.container?.tags), 'Missing container metadata')
    requireValue(version.metadata.container.tags.every((tag) => typeof tag === 'string' && tag.length > 0), 'Invalid version tags')
    timestamp(version.created_at)
    timestamp(version.updated_at)
    ids.add(version.id)
    digests.add(version.name)
  }
}

function datedTag(tag) {
  if (!/^\d{8}$/.test(tag)) return null
  const iso = `${tag.slice(0, 4)}-${tag.slice(4, 6)}-${tag.slice(6)}T00:00:00.000Z`
  const time = Date.parse(iso)
  return Number.isFinite(time) && new Date(time).toISOString() === iso ? time : null
}

export function planRetention(versions, releaseTags, references, now = Date.now()) {
  requireValue(Number.isFinite(now), 'Invalid clock')
  validateVersions(versions)
  const cutoff = now - 30 * DAY
  return versions.filter((version) => {
    const tags = version.metadata.container.tags
    if (!tags.length || references.has(version.name)) return false
    if (Math.max(timestamp(version.created_at), timestamp(version.updated_at)) >= cutoff) return false
    return tags.every((tag) => {
      if (releaseTags.has(tag)) return false
      const date = datedTag(tag)
      return date !== null ? date + DAY <= cutoff : /^sha-[a-f0-9]{7,40}$/.test(tag)
    })
  })
}

export function manifestReferences(manifest) {
  requireValue(manifest?.schemaVersion === 2, 'Unsupported manifest schema')
  const references = []
  if (INDEX_TYPES.includes(manifest.mediaType)) {
    requireValue(Array.isArray(manifest.manifests) && manifest.manifests.length > 0, 'Incomplete manifest index')
    for (const descriptor of manifest.manifests) {
      requireValue(DIGEST.test(descriptor?.digest) && Number.isSafeInteger(descriptor.size) && descriptor.size > 0 && [...INDEX_TYPES, ...IMAGE_TYPES].includes(descriptor.mediaType), 'Invalid manifest descriptor')
      references.push(descriptor.digest)
    }
  } else {
    requireValue(IMAGE_TYPES.includes(manifest.mediaType) && DIGEST.test(manifest.config?.digest) && Array.isArray(manifest.layers), 'Unsupported or incomplete image manifest')
  }
  if (manifest.subject !== undefined) {
    requireValue(DIGEST.test(manifest.subject?.digest), 'Invalid manifest subject')
    references.push(manifest.subject.digest)
  }
  return references
}

export async function paginate(read, path) {
  const values = []
  for (let page = 1; page <= 100; page++) {
    const batch = await read(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    requireValue(Array.isArray(batch) && batch.length <= 100, 'Invalid paginated response')
    if (!batch.length) return values
    values.push(...batch)
  }
  throw new Error('Pagination safety limit exceeded; no deletion allowed')
}

function snapshot(versions, releases) {
  return JSON.stringify({ versions: [...versions].sort((a, b) => a.id - b.id).map((v) => [v.id, v.name, v.created_at, v.updated_at, [...v.metadata.container.tags].sort()]), releases: [...releases].sort() })
}

export async function runRetention({ repository, ownerType, token, actor, apply = false, fetchImpl = fetch, now = Date.now(), log = console.log }) {
  requireValue(/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repository), 'Invalid repository')
  requireValue(['User', 'Organization'].includes(ownerType), 'Explicit package owner type required')
  requireValue(token && actor, 'Authentication required')
  const [owner, packageName] = repository.split('/')
  const base = `/${ownerType === 'User' ? 'users' : 'orgs'}/${owner}/packages/container/${encodeURIComponent(packageName.toLowerCase())}`
  const request = async (url, headers, method = 'GET') => {
    const response = await fetchImpl(url, { method, headers, redirect: 'error', signal: AbortSignal.timeout(30_000) })
    requireValue(response.status === (method === 'DELETE' ? 204 : 200), `${method} ${url}: HTTP ${response.status}`)
    return response
  }
  const apiHeaders = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  const read = async (path) => (await request(`https://api.github.com${path}`, apiHeaders)).json()
  const inventory = async () => {
    const info = await read(base)
    requireValue(info.name === packageName.toLowerCase() && info.package_type === 'container' && info.repository?.full_name?.toLowerCase() === repository.toLowerCase(), 'Package identity or repository association mismatch')
    requireValue(Number.isSafeInteger(info.version_count) && info.version_count >= 0, 'Missing package version count')
    const versions = await paginate(read, `${base}/versions?state=active`)
    validateVersions(versions)
    requireValue(versions.length === info.version_count, 'Incomplete or changing package inventory')
    const tags = await paginate(read, `/repos/${repository}/tags`)
    const releases = await paginate(read, `/repos/${repository}/releases`)
    const releaseTags = new Set()
    for (const tag of [...tags.map((t) => t.name), ...releases.map((r) => r.tag_name)]) {
      requireValue(typeof tag === 'string' && tag.length > 0, 'Incomplete release/tag data')
      releaseTags.add(tag)
      releaseTags.add(tag.replace(/[^\w.-]/g, '-').replace(/^[.-]+/, ''))
    }
    return { versions, releaseTags }
  }
  const first = await inventory()
  // Untagged versions are never candidates, but their indexes can still reference tagged children.
  let candidates = planRetention(first.versions, first.releaseTags, new Set(), now)
  if (!candidates.length) {
    log('No expired dated/SHA versions eligible for deletion.')
    return []
  }
  const auth = await request(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repository.toLowerCase()}:pull`, { Authorization: `Basic ${Buffer.from(`${actor}:${token}`).toString('base64')}` })
  const credentials = await auth.json()
  requireValue(typeof credentials.token === 'string' && credentials.token.length > 0, 'Missing registry pull token')
  const references = new Set()
  const visited = new Set()
  const inspect = async (digest) => {
    if (visited.has(digest)) return
    requireValue(visited.size < 10_000, 'Manifest safety limit exceeded')
    visited.add(digest)
    const response = await request(`https://ghcr.io/v2/${repository.toLowerCase()}/manifests/${digest}`, { Authorization: `Bearer ${credentials.token}`, Accept: ACCEPT })
    const bytes = Buffer.from(await response.arrayBuffer())
    requireValue(`sha256:${createHash('sha256').update(bytes).digest('hex')}` === digest, 'Registry digest mismatch')
    for (const child of manifestReferences(JSON.parse(bytes.toString('utf8')))) {
      references.add(child)
      await inspect(child)
    }
  }
  for (const version of first.versions) await inspect(version.name)
  candidates = planRetention(first.versions, first.releaseTags, references, now)
  const second = await inventory()
  requireValue(snapshot(first.versions, first.releaseTags) === snapshot(second.versions, second.releaseTags), 'Inventory changed during planning; no deletion allowed')
  for (const version of candidates) log(`${apply ? 'Delete' : 'Would delete'} ${version.id} ${version.name} ${version.metadata.container.tags.join(',')}`)
  if (apply) {
    let remaining = first.versions
    for (const version of candidates) {
      const current = await inventory()
      requireValue(snapshot(remaining, first.releaseTags) === snapshot(current.versions, current.releaseTags), 'Inventory changed before deletion; stopping')
      const live = await read(`${base}/versions/${version.id}`)
      validateVersions([live])
      requireValue(snapshot([version], []) === snapshot([live], []), 'Version changed before deletion; stopping')
      await request(`https://api.github.com${base}/versions/${version.id}`, apiHeaders, 'DELETE')
      remaining = remaining.filter((v) => v.id !== version.id)
    }
  }
  log(`${apply ? 'Deleted' : 'Dry-run candidates:'} ${candidates.length}; untagged and referenced manifests preserved.`)
  return candidates.map((v) => v.id)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  requireValue(process.argv.slice(2).every((arg) => arg === '--apply'), 'Only --apply is supported; default is dry-run')
  await runRetention({ repository: process.env.GITHUB_REPOSITORY, ownerType: process.env.PACKAGE_OWNER_TYPE, token: process.env.GITHUB_TOKEN, actor: process.env.GITHUB_ACTOR, apply: process.argv.includes('--apply') })
}
