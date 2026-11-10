import { describe, expect, it } from 'vitest'
import { TARGETS } from './generators'
import { blankRule } from './model'
import { parseJson, toJson } from './json'
import { decodeState, encodeState } from './share'
import { parseCsv, toCsv } from './csv'
import { sectionRuns } from './grouping'
import { generateGroupedOutput } from './groupedOutput'
import { appendSectionedRules, emptySections, normalizeSections, restoreSections, serializeSections } from './sections'
import { LEGACY_WORKSPACE_KEY, loadWorkspace, serializeWorkspace, WORKSPACE_KEY } from './workspace'
import type { SectionState } from './sections'
import type { Rule, TargetId } from './model'

const rules = ['first', 'disabled', 'last'].map((id, index) => ({ ...blankRule(), id, name: id, enabled: index !== 1 }))
const sections: SectionState = { titles: { unsectioned: 'Unsectioned', a: 'Application 🛡️', b: 'DNS', empty: 'Empty section' }, membership: { first: 'a', disabled: 'a', last: 'b' }, nsxSeparatePolicies: true }
const workspace = (target: TargetId = 'nsx', data = rules, state = sections) => ({ rules: data, target, policyName: 'reviewed-policy', nsxProject: 'project-1', nsxCategory: 'Environment', sections: state })
const storage = (key: string, value: string) => ({ getItem: (requested: string) => requested === key ? value : null })
const fields = (data: Rule[]) => data.map(({ id: _id, ...rest }) => rest)

async function packed(version: string, data: unknown) {
  const stream = new CompressionStream('deflate-raw')
  const writer = stream.writable.getWriter()
  void writer.write(new TextEncoder().encode(JSON.stringify(data)))
  void writer.close()
  const bytes = new Uint8Array(await new Response(stream.readable).arrayBuffer())
  return `s=${version}.${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

describe('portable sections across all targets', () => {
  it.each(TARGETS.map((target) => target.id))('%s preserves order, disabled states, section identities and empty sections in JSON/share/reload', async (target) => {
    const state = workspace(target)
    const json = parseJson(toJson(rules, state))
    expect(json.error).toBeUndefined()
    expect(json.warnings).toEqual([])
    expect(json.meta).toMatchObject({ target, policyName: state.policyName, nsxProject: state.nsxProject, nsxCategory: state.nsxCategory })
    expect(fields(json.rules)).toEqual(fields(rules))
    expect(json.rules[0].id).not.toBe(rules[0].id)
    expect(serializeSections(json.rules, json.sections)).toEqual(serializeSections(rules, sections))
    const shared = await decodeState(await encodeState(state))
    expect(shared?.warnings).toEqual([])
    expect(fields(shared!.rules)).toEqual(fields(rules))
    expect(serializeSections(shared!.rules, shared?.sections)).toEqual(serializeSections(rules, sections))
    const stored = serializeWorkspace(state)
    expect(JSON.parse(stored).version).toBe(3)
    const loaded = loadWorkspace(storage(WORKSPACE_KEY, stored))
    expect(loaded.rules).toEqual(rules)
    expect(loaded.sections).toEqual(sections)
    expect(loaded.target).toBe(target)
    expect(loaded.warnings).toEqual([])
  })

  it.each(['windows', 'nsx', 'nsx-ps', 'nsx-sdk'] as const)('%s reproduces generated output after JSON/share/reload', async (target) => {
    const state = workspace(target)
    const original = generateGroupedOutput(rules, target, state, sectionRuns(rules, sections.membership), sections.titles, true)
    const json = parseJson(toJson(rules, state))
    const shared = await decodeState(await encodeState(state))
    const loaded = loadWorkspace(storage(WORKSPACE_KEY, serializeWorkspace(state)))
    for (const restored of [json, shared!, loaded]) {
      const groups = restored.sections!
      expect(generateGroupedOutput(restored.rules, target, state, sectionRuns(restored.rules, groups.membership), groups.titles, groups.nsxSeparatePolicies)).toEqual(original)
    }
  })

  it('keeps noncontiguous membership and blocks separate NSX policies rather than sorting', () => {
    const state = { ...sections, membership: { first: 'a', disabled: 'b', last: 'a' } }
    const back = parseJson(toJson(rules, workspace('nsx', rules, state)))
    expect(back.rules.map((rule) => rule.name)).toEqual(['first', 'disabled', 'last'])
    const runs = sectionRuns(back.rules, back.sections!.membership)
    expect(runs.map((run) => [run.group, run.continued])).toEqual([['a', false], ['b', false], ['a', true]])
    expect(generateGroupedOutput(back.rules, 'nsx', workspace(), runs, back.sections!.titles, true).blocked).toBe(true)
  })

  it('round-trips an empty workspace with named empty sections', async () => {
    const state = workspace('windows', [], { ...sections, membership: {} })
    const json = parseJson(toJson([], state))
    expect(json.error).toBeUndefined()
    expect(json.sections?.titles).toEqual(sections.titles)
    expect((await decodeState(await encodeState(state)))?.sections?.titles).toEqual(sections.titles)
    expect(loadWorkspace(storage(WORKSPACE_KEY, serializeWorkspace(state))).sections.titles).toEqual(sections.titles)
  })

  it('leaves CSV rule-only and preserves source row order and disabled states', () => {
    const csv = toCsv(rules)
    expect(csv).not.toMatch(/Application|Empty section|ruleSections|membership/)
    expect(parseCsv(csv).map((rule) => [rule.name, rule.enabled])).toEqual(rules.map((rule) => [rule.name, rule.enabled]))
  })
})

describe('migration and malformed section metadata', () => {
  it('migrates legacy local workspaces without inventing lost sections or changing rule IDs/order', () => {
    const old = { ...workspace('windows'), sections: undefined }
    const loaded = loadWorkspace(storage(LEGACY_WORKSPACE_KEY, JSON.stringify(old)))
    expect(loaded.rules).toEqual(rules)
    expect(loaded.sections).toEqual(emptySections())
    expect(loaded.warnings).toEqual([])
    expect(loaded.canSave).toBe(true)
  })

  it('regenerates duplicate, missing and unsafe saved rule IDs while preserving positional membership', () => {
    const saved = [{ ...rules[0], id: 'duplicate' }, null, { ...rules[1], id: 'duplicate' }, { ...rules[2], id: '__proto__' }, { ...rules[0], id: undefined }]
    const metadata = { ...serializeSections(rules, sections), ruleSections: ['a', 'b', 'a', 'b', 'a'] }
    const loaded = loadWorkspace(storage(WORKSPACE_KEY, JSON.stringify({ version: 3, rules: saved, sections: metadata })))
    expect(new Set(loaded.rules.map((rule) => rule.id)).size).toBe(4)
    expect(loaded.rules[0].id).toBe('duplicate')
    expect(loaded.rules.map((rule) => rule.id)).not.toContain('__proto__')
    expect(serializeSections(loaded.rules, loaded.sections).ruleSections).toEqual(['a', 'a', 'b', 'a'])
  })

  it('prefers the current workspace over a legacy backup', () => {
    const current = serializeWorkspace(workspace('windows'))
    const loaded = loadWorkspace({ getItem: (key) => key === WORKSPACE_KEY ? current : JSON.stringify(workspace('nsx')) })
    expect(loaded.target).toBe('windows')
    expect(loaded.sections).toEqual(sections)
  })

  it('does not permit overwriting unsupported or unreadable saved workspace data', () => {
    for (const raw of ['', '{broken', JSON.stringify({ version: 99, rules }), JSON.stringify({ version: 3 }), JSON.stringify({ version: 3, rules: 'invalid' })]) {
      const loaded = loadWorkspace(storage(WORKSPACE_KEY, raw))
      expect(loaded.canSave).toBe(false)
      expect(loaded.warnings).toHaveLength(1)
    }
  })

  it('reads version 1 JSON and bare rule arrays with fresh IDs and no sections', () => {
    for (const text of [JSON.stringify({ format: 'firewall-forge-rules', version: 1, rules }), JSON.stringify(rules)]) {
      const loaded = parseJson(text)
      expect(fields(loaded.rules)).toEqual(fields(rules))
      expect(loaded.sections).toBeUndefined()
      expect(loaded.error).toBeUndefined()
    }
    expect(parseJson(JSON.stringify({ format: 'firewall-forge-rules', version: 99, rules })).error).toContain('Unsupported')
  })

  it('reads version 1 share links without assigning invented sections', async () => {
    const back = await decodeState(await packed('1', { t: 'windows', n: 'legacy', r: rules }))
    expect(fields(back!.rules)).toEqual(fields(rules))
    expect(back?.sections).toEqual(emptySections())
    expect(back?.warnings).toEqual([])
    expect(await decodeState(await packed('99', { r: rules }))).toBeNull()
  })

  it.each([null, { version: 99 }, { version: 1, titles: [], ruleSections: [] }, { version: 1, titles: {}, ruleSections: 'bad' }])('ignores malformed/unsupported sections without changing rules (%j)', (metadata) => {
    const result = restoreSections(metadata, rules)
    expect(result.sections).toEqual(emptySections())
    expect(result.warnings).toHaveLength(1)
    expect(rules.map((rule) => rule.name)).toEqual(['first', 'disabled', 'last'])
  })

  it('drops missing/deleted references, malformed values and unsafe keys with a warning, retaining valid sections', () => {
    const metadata = { version: 1, titles: JSON.parse('{"a":"Application","empty":"Empty","__proto__":"Unsafe"}'), ruleSections: ['a', 'deleted', 10, 'stale'], nsxSeparatePolicies: true }
    const result = restoreSections(metadata, rules)
    expect(result.sections.membership).toEqual({ first: 'a' })
    expect(result.sections.titles).toEqual({ unsectioned: 'Unsectioned', a: 'Application', empty: 'Empty' })
    expect(result.sections.nsxSeparatePolicies).toBe(false)
    expect(result.warnings).toHaveLength(1)
    expect(Object.hasOwn(result.sections.titles, '__proto__')).toBe(false)
  })

  it('keeps positional references aligned if JSON skips a malformed rule record', () => {
    const metadata = { ...serializeSections(rules, sections), ruleSections: ['a', 'b', 'a', 'b'] }
    const back = parseJson(JSON.stringify({ rules: [rules[0], null, rules[1], rules[2]], sections: metadata }))
    expect(back.rules.map((rule) => rule.name)).toEqual(['first', 'disabled', 'last'])
    expect(serializeSections(back.rules, back.sections).ruleSections).toEqual(['a', 'a', 'b'])
  })

  it('ignores inherited titles/membership and prunes deleted runtime rule references without removing empty sections', () => {
    const state = { ...sections, membership: Object.assign(Object.create({ disabled: 'a' }), { first: 'a', deleted: 'b' }), titles: Object.assign(Object.create({ inherited: 'Unsafe' }), sections.titles) }
    const normalized = normalizeSections(rules, state)
    expect(normalized.membership).toEqual({ first: 'a' })
    expect(normalized.titles).toEqual(sections.titles)
    expect(serializeSections(rules, normalized).ruleSections).toEqual(['a', 'unsectioned', 'unsectioned'])
  })

  it('reports invalid section metadata through JSON, share and storage adapters', async () => {
    const json = parseJson(JSON.stringify({ format: 'firewall-forge-rules', version: 2, rules, sections: null }))
    const share = await decodeState(await packed('2', { t: 'windows', n: 'test', r: rules, s: null }))
    const loaded = loadWorkspace(storage(WORKSPACE_KEY, JSON.stringify({ version: 3, rules, target: 'windows', sections: null })))
    for (const back of [json, share!, loaded]) {
      expect(fields(back.rules)).toEqual(fields(rules))
      expect(back.sections).toEqual(emptySections())
      expect(back.warnings).toHaveLength(1)
    }
  })
})

describe('section-aware JSON append', () => {
  const incoming = [{ ...blankRule(), id: 'added', name: 'new-rule' }]
  const imported: SectionState = { membership: { added: 'new-section' }, titles: { unsectioned: 'Unsectioned', 'new-section': 'Application 🛡️' }, nsxSeparatePolicies: false }

  it('appends an intact ordered block, never merges by display name and keeps existing layout', () => {
    const added = appendSectionedRules(rules, sections, incoming, imported)
    expect(added.rules.map((rule) => rule.id)).toEqual(['first', 'disabled', 'last', 'added'])
    expect(added.sections.membership).toEqual({ ...sections.membership, added: 'new-section' })
    expect(added.sections.titles.a).toBe(added.sections.titles['new-section'])
    expect(added.sections.nsxSeparatePolicies).toBe(true)
    expect(added.warnings).toHaveLength(1)
  })

  it('restores the incoming layout and exact section identities into an empty workspace', () => {
    const added = appendSectionedRules([], emptySections(), rules, sections)
    expect(added.rules).toEqual(rules)
    expect(added.sections).toEqual(sections)
    expect(added.warnings).toEqual([])
  })

  it('rejects conflicting section IDs before adding/reordering rules or changing existing metadata', () => {
    const conflict = { ...imported, titles: { a: 'Other label' }, membership: { added: 'a' } }
    const added = appendSectionedRules(rules, sections, incoming, conflict)
    expect(added.error).toContain('overlap')
    expect(added.rules).toBe(rules)
    expect(added.sections).toEqual(sections)
    expect(sections.titles.a).toBe('Application 🛡️')
  })
})
