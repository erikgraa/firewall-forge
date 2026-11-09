import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { blankRule } from './model'
import type { Rule, TargetId } from './model'
import Topology from './TopologyView'

const rule = (change: Partial<Rule> = {}): Rule => ({ ...blankRule(), name: 'web', source: '10.20.0.0/24', destination: '10.10.10.1', ...change })
const render = (rules: Rule[], target: TargetId = 'mikrotik', selectedId = rules[0]?.id ?? '') => renderToStaticMarkup(<Topology rules={rules} target={target} platformLabel="Firewall" selectedId={selectedId} onSelect={() => {}} onPatch={() => {}} onOpenTable={() => {}} extraFields={() => <span>Target fields</span>} />)

describe('topology rendering', () => {
  it('provides keyboard-selectable routes, a linked editor and intent caveats', () => {
    const markup = render([rule()])
    expect(markup).toContain('role="button" tabindex="0" aria-pressed="true"')
    expect(markup).toContain('Open in Rules')
    expect(markup).toContain('aria-label="Topology source matcher"')
    expect(markup).toContain('Target fields')
    expect(markup).toContain('not a discovered network')
    expect(markup).toContain('ALLOW is not proof of reachability')
  })

  it.each(['ALLOW', 'DROP', 'REJECT'] as const)('%s represents delivery intent without implying delivery for blocks', (action) => {
    const markup = render([rule({ action })])
    const destination = markup.match(/class="topology-edge destination-association"[^>]+/)![0]
    if (action === 'ALLOW') expect(destination).toContain('marker-end=')
    else {
      expect(destination).not.toContain('marker-end=')
      expect(destination).toContain('stroke-dasharray="5 5"')
    }
  })

  it('lists disabled rules but does not draw them by default', () => {
    const markup = render([rule({ enabled: false })])
    expect(markup).toContain('DISABLED')
    expect(markup).toContain('aria-label="Topology rule enabled" type="checkbox"')
    expect(markup).not.toContain('data-rule-id=')
  })

  it('escapes user labels and preserves full matcher text', () => {
    const name = '<img src=x onerror=alert(1)>'
    const source = '10.20.0.0/24,10.30.0.0/24'
    const markup = render([rule({ name, source })])
    expect(markup).not.toContain('<img src=x')
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(markup).toContain(`<title>${source}</title>`)
  })

  it('uses generic policy context on non-MikroTik targets', () => {
    const markup = render([rule({ routerosChain: 'forward' })], 'windows')
    expect(markup).toContain('Rule intent')
    expect(markup).not.toContain('through router')
    expect(markup).not.toContain('Topology chain filter')
  })

  it('excludes invalid and duplicate routes while retaining editable diagnostics', () => {
    const markup = render([rule(), rule({ source: '300.1.2.3' })])
    expect(markup).not.toContain('data-rule-id=')
    expect(markup).toContain('2 invalid route(s) excluded')
    expect(markup).toContain('Duplicate rule name')
    expect(markup).toContain('INVALID')
  })

  it('falls back to a surviving rule after selection is deleted and handles an empty rule set', () => {
    const remaining = rule()
    expect(render([remaining], 'mikrotik', 'deleted')).toContain(`data-rule-id="${remaining.id}" role="button" tabindex="0" aria-pressed="true"`)
    expect(render([])).toContain('Add or import a rule to start exploring')
  })

  it('spaces repeated routes and expands the SVG to avoid clipping endpoints', () => {
    const rules = Array.from({ length: 12 }, (_, index) => rule({ name: `rule-${index}`, source: `10.20.${index}.1` }))
    const markup = render(rules)
    const positions = [...markup.matchAll(/class="topology-route-pill" x="282" y="([\d.]+)"/g)].map((match) => Number(match[1]))
    expect(positions).toHaveLength(12)
    expect(new Set(positions).size).toBe(12)
    expect(positions[1] - positions[0]).toBe(28)
    const height = Number(markup.match(/viewBox="0 0 1050 (\d+)"/)![1])
    expect(height).toBeGreaterThan(160 + 11 * 140 + 34)
  })
})
