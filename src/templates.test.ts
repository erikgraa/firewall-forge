import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { blankRule } from './model'
import type { Rule } from './model'
import RuleTemplates from './RuleTemplates'
import { createTemplateRules, STARTER_TEMPLATES } from './templates'
import type { TemplateId } from './templates'

const options = 'nftables' as const
const noop = () => {}
const protocols = (rules: Rule[]) => rules.map(({ protocol, ports, service }) => ({ protocol, ports, service }))

describe('starter template construction', () => {
  it('exports the three named, descriptive starters', () => {
    expect(STARTER_TEMPLATES.map(({ id, title }) => [id, title])).toEqual([
      ['ssh', 'SSH server'], ['web', 'Web server'], ['dns', 'DNS server'],
    ])
    expect(STARTER_TEMPLATES.every(({ description, services }) => description.length > 20 && services.length > 0)).toBe(true)
  })

  it('allows SSH on TCP 22 only', () => {
    expect(protocols(createTemplateRules('ssh', options))).toEqual([{ protocol: 'TCP', ports: '22', service: 'SSH (TCP 22)' }])
  })

  it('adds exactly one HTTPS rule without silently adding HTTP', () => {
    expect(protocols(createTemplateRules('web', options))).toEqual([{ protocol: 'TCP', ports: '443', service: 'HTTPS (TCP 443)' }])
  })

  it('allows DNS on UDP 53 and TCP 53', () => {
    expect(protocols(createTemplateRules('dns', options))).toEqual([
      { protocol: 'UDP', ports: '53', service: 'DNS (UDP 53)' },
      { protocol: 'TCP', ports: '53', service: 'DNS (TCP 53)' },
    ])
  })

  it.each(['ssh', 'web', 'dns'] as const)('%s adds disabled rules with editable Any endpoints and no automatic scope', (template) => {
    const added = createTemplateRules(template, options)
    for (const rule of added) {
      expect(rule).toMatchObject({
        source: 'Any', destination: 'Any', action: 'ALLOW', direction: 'Inbound',
        routerosChain: 'Auto', enabled: false, logging: false, priority: '', scope: '', zone: '', srcZone: '', dstZone: '',
      })
    }
    expect(added).toHaveLength(template === 'dns' ? 2 : 1)
  })

  it.each(['mikrotik', 'mikrotik-tf'] as const)('defaults %s to forward without enabling access', (target) => {
    const added = createTemplateRules('dns', target)
    expect(added.every((rule) => rule.routerosChain === 'forward' && rule.direction === 'Inbound' && !rule.enabled)).toBe(true)
  })

  it('uses Auto for other targets', () => {
    for (const target of ['nftables', 'windows', 'firewalld', 'nsx', 'azl-nsg'] as const) {
      expect(createTemplateRules('ssh', target)[0].routerosChain).toBe('Auto')
    }
  })

  it('produces fresh IDs within batches and on repeated invocations', () => {
    const rules = [
      ...createTemplateRules('dns', options), ...createTemplateRules('dns', options),
      ...createTemplateRules('web', options), ...createTemplateRules('ssh', options),
    ]
    expect(new Set(rules.map(({ id }) => id)).size).toBe(rules.length)
    expect(rules.every(({ id }) => id.length > 0)).toBe(true)
  })

  it('adds readable numeric name suffixes and skips existing suffix collisions', () => {
    const first = createTemplateRules('dns', options)
    const collision = { ...blankRule(), name: `${first[0].name} (2)` }
    const second = createTemplateRules('dns', options, [...first, collision])
    expect(second.map(({ name }) => name)).toEqual([`${first[0].name} (3)`, `${first[1].name} (2)`])
    const third = createTemplateRules('dns', options, [...first, collision, ...second])
    const all = [...first, collision, ...second, ...third]
    expect(new Set(all.map(({ name }) => name)).size).toBe(all.length)
    expect(new Set(third.map(({ name }) => name)).size).toBe(third.length)
  })

  it('never mutates, reorders, returns, or replaces frozen existing rules', () => {
    const first = Object.freeze({ ...blankRule(), name: 'DNS server UDP 53', notes: 'keep me', action: 'DROP' as const })
    const last = Object.freeze({ ...blankRule(), name: 'last', priority: '9', scope: 'existing scope' })
    const existing: readonly Rule[] = Object.freeze([first, last])
    const before = JSON.stringify(existing)
    const added = createTemplateRules('dns', options, existing)
    expect(JSON.stringify(existing)).toBe(before)
    expect(existing[0]).toBe(first)
    expect(existing[1]).toBe(last)
    expect(added).toHaveLength(2)
    expect(added.every((rule) => !existing.includes(rule))).toBe(true)
    expect(added[0].name).toBe('DNS server UDP 53 (2)')
    expect(() => createTemplateRules('unknown' as TemplateId, options, existing)).toThrow()
    expect(JSON.stringify(existing)).toBe(before)
  })

  it('rejects unknown templates', () => {
    expect(() => createTemplateRules('unknown' as TemplateId, options)).toThrow(/Choose a starter template/)
  })
})

describe('starter gallery accessibility and safe defaults', () => {
  it('starts expanded on an empty policy with three unselected native buttons and no configured endpoints', () => {
    const html = renderToStaticMarkup(createElement(RuleTemplates, { rules: [], target: 'nftables', onAdd: noop }))
    expect(html).toMatch(/<details[^>]* open=""/)
    expect(html).toContain('<summary class="template-summary">Starter templates</summary>')
    expect(html.match(/data-template=/g)).toHaveLength(3)
    expect(html.match(/<svg class="button-icon"/g)).toHaveLength(3)
    expect(html.match(/aria-hidden="true" focusable="false"/g)).toHaveLength(3)
    expect(html).not.toContain('aria-pressed')
    expect(html.match(/type="button"/g)).toHaveLength(3)
    expect(html).toContain('SSH server')
    expect(html).toContain('Web server')
    expect(html).toContain('DNS server')
    expect(html).toContain('One click adds disabled starter rules.')
    expect(html).toContain('Addresses start as Any; rules stay disabled until you enable them.')
    expect(html).toContain('direction, RouterOS chain, zones/scope and existing policy')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<form')
  })

  it('starts collapsed when rules already exist', () => {
    const html = renderToStaticMarkup(createElement(RuleTemplates, { rules: [blankRule()], target: 'windows', onAdd: noop }))
    expect(html).not.toMatch(/<details[^>]* open=/)
  })

  it.each(STARTER_TEMPLATES)('$title adds the complete disabled recipe in one click without modifying existing rules', (template) => {
    const existing = [Object.freeze({ ...blankRule(), name: 'existing', source: '192.0.2.1' })]
    const before = JSON.stringify(existing)
    const onAdd = vi.fn()
    const gallery = RuleTemplates({ rules: existing, target: 'mikrotik', onAdd })
    const buttons = gallery.props.children[2].props.children as { props: { 'data-template': string; onClick: () => void } }[]
    buttons.find((button) => button.props['data-template'] === template.id)!.props.onClick()
    expect(onAdd).toHaveBeenCalledTimes(1)
    const [added, title] = onAdd.mock.calls[0] as [Rule[], string]
    expect(title).toBe(template.title)
    expect(added).toHaveLength(template.id === 'dns' ? 2 : 1)
    expect(added.every((rule) => !rule.enabled && rule.source === 'Any' && rule.destination === 'Any' && rule.routerosChain === 'forward')).toBe(true)
    expect(JSON.stringify(existing)).toBe(before)
  })
})
