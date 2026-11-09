import { describe, expect, it } from 'vitest'
import { blankRule } from './model'
import { projectTopology, topologyContext } from './topology'

const options = { search: '', chain: 'all', showDisabled: false }
const rule = () => ({ ...blankRule(), name: 'web', source: '10.20.0.0/24', destination: '10.10.10.1' })

describe('shared rule topology projection', () => {
  it('preserves rules and their identities while grouping matchers by role', () => {
    const a = rule(); const b = { ...rule(), name: 'second' }
    const before = JSON.stringify([a, b])
    const graph = projectTopology([a, b], 'mikrotik', options)
    expect(graph.routes.map((route) => route.id)).toEqual([a.id, b.id])
    expect(graph.sources).toHaveLength(1)
    expect(graph.destinations).toHaveLength(1)
    expect(graph.sources[0].id).not.toBe(graph.destinations[0].id)
    expect(JSON.stringify([a, b])).toBe(before)
    const reordered = projectTopology([b, a], 'mikrotik', options)
    expect(reordered.sources).toEqual(graph.sources)
    expect(reordered.routes[1]).toMatchObject({ id: a.id, order: 2 })
  })
  it('uses shared Auto/explicit chains for both MikroTik formats', () => {
    const r = { ...rule(), direction: 'Outbound' as const }
    expect(topologyContext(r, 'mikrotik')).toBe('output')
    expect(topologyContext({ ...r, routerosChain: 'forward' }, 'mikrotik-tf')).toBe('forward')
    expect(topologyContext({ ...r, routerosChain: 'forward' }, 'windows')).toBe('policy')
  })
  it('filters disabled rules without removing or modifying their data', () => {
    const r = { ...rule(), enabled: false }
    expect(projectTopology([r], 'mikrotik', options).routes).toHaveLength(0)
    expect(projectTopology([r], 'mikrotik', { ...options, showDisabled: true }).routes[0].rule.enabled).toBe(false)
  })
  it('excludes invalid addresses and blank matchers rather than broadening them', () => {
    for (const source of ['300.1.2.3', '', 'Internet']) {
      const graph = projectTopology([{ ...rule(), source }], 'mikrotik', options)
      expect(graph.routes).toHaveLength(0)
      expect(graph.invalid).toBe(1)
      expect(graph.sources).toHaveLength(0)
    }
  })
  it('uses shared service and port validation', () => {
    const graph = projectTopology([{ ...rule(), ports: '65536' }], 'mikrotik-tf', options)
    expect(graph.invalid).toBe(1)
    expect(graph.routes).toHaveLength(0)
  })
  it('supports case-insensitive search and real chain filters', () => {
    const a = rule(); const b = { ...rule(), name: 'dns', routerosChain: 'forward' as const }
    expect(projectTopology([a, b], 'mikrotik', { ...options, search: 'DNS', chain: 'forward' }).routes.map((route) => route.id)).toEqual([b.id])
    expect(projectTopology([a, b], 'windows', { ...options, chain: 'forward' }).routes).toHaveLength(2)
  })
  it('keeps presets grouped without counting expanded resources as devices', () => {
    const graph = projectTopology([{ ...rule(), source: 'Private networks (RFC1918)' }], 'mikrotik-tf', options)
    expect(graph.routes).toHaveLength(1)
    expect(graph.sources).toHaveLength(1)
  })
  it('excludes duplicate-name routes using the same enabled-rule scope as validation', () => {
    const a = rule(); const b = rule()
    const graph = projectTopology([a, b], 'mikrotik', options)
    expect(graph.routes).toHaveLength(0)
    expect(graph.invalid).toBe(2)
    expect(graph.errors.get(a.id)).toContain('Duplicate rule name "web"')
    expect(projectTopology([a, { ...b, enabled: false }], 'mikrotik', options).routes).toHaveLength(1)
    expect(projectTopology([a, { ...b, enabled: false }], 'windows', options).routes).toHaveLength(0)
  })
  it('preserves original table order through filtering, whitespace grouping and updates', () => {
    const a = rule(); const b = { ...rule(), name: 'other', source: ' 10.20.0.0/24 ' }
    const graph = projectTopology([a, b], 'mikrotik', { ...options, search: 'OTHER' })
    expect(graph.routes[0]).toMatchObject({ id: b.id, order: 2 })
    expect(graph.sources).toHaveLength(1)
    expect(graph.sources[0].value).toBe('10.20.0.0/24')
    expect(graph.routes[0].rule).toBe(b)
  })
  it('updates actions and deletions directly from the shared rule array', () => {
    const r = rule()
    expect(projectTopology([{ ...r, action: 'REJECT' }], 'mikrotik', options).routes[0].rule.action).toBe('REJECT')
    expect(projectTopology([], 'mikrotik', options).routes).toEqual([])
  })
})
