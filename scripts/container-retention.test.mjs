import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { manifestReferences, paginate, planRetention, runRetention } from './container-retention.mjs'

const now = Date.parse('2026-11-10T12:00:00Z')
const old = '2026-09-01T00:00:00Z'
const digest = (n) => `sha256:${n.toString(16).padStart(64, '0')}`
const imageType = 'application/vnd.oci.image.manifest.v1+json'
const indexType = 'application/vnd.oci.image.index.v1+json'
const image = { schemaVersion: 2, mediaType: imageType, config: { digest: digest(999) }, layers: [] }
function version(id, tags, created = old, updated = created, name = digest(id)) {
  return { id, name, created_at: created, updated_at: updated, metadata: { package_type: 'container', container: { tags } } }
}
const plan = (versions, releases = [], refs = []) => planRetention(versions, new Set(releases), new Set(refs), now).map((v) => v.id)

function fixture({ ownerType = 'User', tags = [], releases = [], mutate, failure, corruptManifest = false } = {}) {
  const bytes = JSON.stringify(image)
  const name = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  const versions = [version(1, ['20260901', 'sha-abcdef0'], old, old, name)]
  const calls = []
  let inventoryReads = 0
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options })
    const parsed = new URL(url)
    const path = parsed.pathname
    if (failure?.(url, options)) return new Response('{}', { status: 403 })
    if (options.method === 'DELETE') return new Response(null, { status: 204 })
    if (parsed.hostname === 'ghcr.io') {
      if (path === '/token') return Response.json({ token: 'fixture-registry-token' })
      return new Response(corruptManifest ? '{}' : bytes)
    }
    const base = `/${ownerType === 'User' ? 'users' : 'orgs'}/erikgraa/packages/container/firewall-forge`
    if (path === base) {
      inventoryReads++
      mutate?.(versions, inventoryReads)
      return Response.json({ name: 'firewall-forge', package_type: 'container', version_count: versions.length, repository: { full_name: 'erikgraa/firewall-forge' } })
    }
    if (path === `${base}/versions/1`) return Response.json(versions[0])
    if (path === `${base}/versions`) return Response.json(parsed.searchParams.get('page') === '1' ? versions : [])
    if (path.endsWith('/tags')) return Response.json(parsed.searchParams.get('page') === '1' ? tags : [])
    if (path.endsWith('/releases')) return Response.json(parsed.searchParams.get('page') === '1' ? releases : [])
    throw new Error(`Unexpected request: ${url}`)
  }
  return { calls, versions, options: { repository: 'erikgraa/firewall-forge', ownerType, actor: 'fixture-actor', token: 'fixture-token', fetchImpl, now, log: () => {} } }
}

const deletes = (calls) => calls.filter((call) => call.method === 'DELETE')

describe('container retention selection', () => {
  it('deletes only old dated/SHA versions, preserving mixed protected and unknown tags and untagged manifests', () => {
    expect(plan([
      version(1, ['20260901', 'sha-abcdef0']), version(2, ['sha-abcdef1']),
      version(3, ['20260901', 'latest']), version(4, ['nightly', 'sha-abcdef2']),
      version(5, ['v1.2.3', '20260901']), version(6, ['custom']), version(7, []),
      version(8, ['20260901', 'sha-ABCDEF0']), version(9, ['20260230']),
    ])).toEqual([1, 2])
  })

  it('keeps 30 complete days, recent tag dates and recently updated versions', () => {
    const cutoff = new Date(now - 30 * 86400000).toISOString()
    expect(plan([
      version(1, ['sha-abcdef0'], cutoff), version(2, ['sha-abcdef1'], old, cutoff),
      version(3, ['20261110']), version(4, ['20261011']), version(5, ['20261010']),
      version(6, ['20261130']), version(7, ['sha-abcdef2'], '2026-11-30T00:00:00Z'),
    ])).toEqual([5])
  })

  it('preserves release-tag collisions and referenced tagged children', () => {
    expect(plan([version(1, ['20260901']), version(2, ['sha-abcdef0']), version(3, ['sha-abcdef1'])], ['20260901', 'sha-abcdef0'], [digest(3)])).toEqual([])
  })

  it.each([
    (v) => { delete v.metadata }, (v) => { v.created_at = 'invalid' },
    (v) => { v.updated_at = null }, (v) => { v.name = 'not-a-digest' },
    (v) => { v.metadata.container.tags = [null] }, (v) => { v.id = -1 },
  ])('fails closed on malformed API metadata', (mutate) => {
    const v = version(1, ['20260901'])
    mutate(v)
    expect(() => plan([v])).toThrow()
  })

  it('rejects duplicate IDs and digests', () => {
    expect(() => plan([version(1, []), version(1, [])])).toThrow()
    expect(() => plan([version(1, []), version(2, [], old, old, digest(1))])).toThrow()
  })
})

describe('manifest dependency protection', () => {
  it.each(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'])('recognizes %s indexes and attestation children', (mediaType) => {
    expect(manifestReferences({ schemaVersion: 2, mediaType, manifests: [
      { digest: digest(1), size: 123, mediaType: imageType },
      { digest: digest(2), size: 456, mediaType: indexType },
    ], subject: { digest: digest(3) } })).toEqual([digest(1), digest(2), digest(3)])
    expect(manifestReferences(image)).toEqual([])
  })

  it.each([{ schemaVersion: 1 }, { schemaVersion: 2, mediaType: indexType },
    { schemaVersion: 2, mediaType: indexType, manifests: [] },
    { schemaVersion: 2, mediaType: indexType, manifests: [{ digest: 'broken', size: 123, mediaType: imageType }] },
    { schemaVersion: 2, mediaType: 'unknown' }, { ...image, subject: {} },
  ])('rejects incomplete/unsupported manifests', (manifest) => {
    expect(() => manifestReferences(manifest)).toThrow()
  })
})

describe('retention API and dry-run integration', () => {
  it('paginates until an empty page, including short pages, and propagates errors', async () => {
    const paths = []
    expect(await paginate(async (path) => { paths.push(path); return paths.length < 3 ? [paths.length] : [] }, '/versions?state=active')).toEqual([1, 2])
    expect(paths[2]).toBe('/versions?state=active&per_page=100&page=3')
    await expect(paginate(async () => { throw new Error('API error') }, '/versions')).rejects.toThrow('API error')
    await expect(paginate(async () => [1], '/versions')).rejects.toThrow('safety limit')
    await expect(paginate(async () => ({}), '/versions')).rejects.toThrow('Invalid paginated')
  })

  it('defaults to dry-run and uses user package endpoints without any deletion', async () => {
    const f = fixture()
    expect(await runRetention(f.options)).toEqual([1])
    expect(deletes(f.calls)).toHaveLength(0)
    expect(f.calls.some((c) => c.url.includes('/users/erikgraa/packages/container/firewall-forge/versions?state=active'))).toBe(true)
    expect(f.calls[0].headers['X-GitHub-Api-Version']).toBe('2022-11-28')
    expect(f.calls.every((c) => c.redirect === 'error')).toBe(true)
  })

  it('uses organization endpoints and checks again before an explicitly requested deletion', async () => {
    const f = fixture({ ownerType: 'Organization' })
    expect(await runRetention({ ...f.options, apply: true })).toEqual([1])
    expect(deletes(f.calls).map((c) => c.url)).toEqual(['https://api.github.com/orgs/erikgraa/packages/container/firewall-forge/versions/1'])
    expect(f.calls.filter((c) => new URL(c.url).pathname.endsWith('/firewall-forge')).length).toBe(3)
  })

  it.each([{ tags: [{ name: '20260901' }] }, { releases: [{ tag_name: 'sha-abcdef0' }] }])('preserves all repository tags and releases, including ephemeral-looking tags', async (options) => {
    const f = fixture(options)
    expect(await runRetention({ ...f.options, apply: true })).toEqual([])
    expect(deletes(f.calls)).toHaveLength(0)
  })

  it.each([2, 3])('stops without deleting on an inventory change at read %s', async (read) => {
    const f = fixture({ mutate: (versions, n) => { if (n === read) versions[0].metadata.container.tags.push('latest') } })
    await expect(runRetention({ ...f.options, apply: true })).rejects.toThrow('Inventory changed')
    expect(deletes(f.calls)).toHaveLength(0)
  })

  it.each(['package', 'versions', 'tags', 'releases', 'registry'])('fails closed on %s API failure', async (stage) => {
    const f = fixture({ failure: (url) => {
      const path = new URL(url).pathname
      return stage === 'package' ? path.endsWith('/firewall-forge') : stage === 'registry' ? url.includes('ghcr.io') : path.endsWith(`/${stage}`)
    } })
    await expect(runRetention({ ...f.options, apply: true })).rejects.toThrow('HTTP 403')
    expect(deletes(f.calls)).toHaveLength(0)
  })

  it('fails closed if registry content does not match its digest', async () => {
    const f = fixture({ corruptManifest: true })
    await expect(runRetention({ ...f.options, apply: true })).rejects.toThrow('digest mismatch')
    expect(deletes(f.calls)).toHaveLength(0)
  })

  it('validates complete inventory counts and repository association', async () => {
    for (const mismatch of [{ version_count: 20 }, { repository: { full_name: 'someone/else' } }]) {
      const f = fixture()
      const fetchImpl = async (url, options) => {
        const response = await f.options.fetchImpl(url, options)
        return new URL(url).pathname.endsWith('/firewall-forge') ? Response.json({ ...await response.json(), ...mismatch }) : response
      }
      await expect(runRetention({ ...f.options, fetchImpl, apply: true })).rejects.toThrow()
      expect(deletes(f.calls)).toHaveLength(0)
    }
  })

  it('protects nested indexes and children even when a child has an expired SHA tag', async () => {
    const f = fixture()
    const child = f.versions[0].name
    const nested = JSON.stringify({ schemaVersion: 2, mediaType: indexType, manifests: [{ digest: child, size: 123, mediaType: imageType }] })
    const nestedDigest = `sha256:${createHash('sha256').update(nested).digest('hex')}`
    const root = JSON.stringify({ schemaVersion: 2, mediaType: indexType, manifests: [{ digest: nestedDigest, size: nested.length, mediaType: indexType }] })
    const rootDigest = `sha256:${createHash('sha256').update(root).digest('hex')}`
    f.versions.push(version(2, ['latest'], old, old, rootDigest))
    const fetchImpl = async (url, options) => {
      if (url.endsWith(nestedDigest)) return new Response(nested)
      if (url.endsWith(rootDigest)) return new Response(root)
      return f.options.fetchImpl(url, options)
    }
    expect(await runRetention({ ...f.options, fetchImpl, apply: true })).toEqual([])
    expect(deletes(f.calls)).toHaveLength(0)
  })
})

describe('container workflow contract', () => {
  const workflow = readFileSync(new URL('../.github/workflows/container.yml', import.meta.url), 'utf8')
  it('preserves the nightly schedule and existing publication tags, and serializes publishers', () => {
    expect(workflow).toContain("cron: '30 2 * * *'")
    for (const tag of ['type=raw,value=latest', "type=raw,value={{date 'YYYYMMDD'}}", 'type=sha,format=short']) expect(workflow).toContain(tag)
    expect(workflow).toContain("github.event_name == 'pull_request' && github.ref || 'publish'")
    expect(workflow).toContain("github.ref == 'refs/heads/main'")
    expect(workflow).toContain('needs: image')
    expect(workflow).toContain("needs.image.result == 'success'")
  })

  it('filters both main pushes and pull requests to actual build and policy inputs', () => {
    expect(workflow).toContain('paths: &container-paths')
    expect(workflow).toContain('paths: *container-paths')
    for (const input of ['src/**', 'public/**', 'scripts/**', 'package.json', 'package-lock.json', 'index.html', 'vite.config.*', 'tsconfig*.json', 'Dockerfile', 'nginx.conf', '.dockerignore', '.github/workflows/container.yml']) expect(workflow).toContain(`'${input}'`)
    expect(workflow).not.toContain("'docs/**'")
    expect(workflow).not.toContain("'README.md'")
  })
})
