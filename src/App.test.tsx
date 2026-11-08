import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import App from './App'
import { TARGETS, PLATFORMS } from './generators'
import { COLUMNS, EXTRA_COLUMNS } from './columns'
import { blankRule } from './model'
import type { Rule, TargetId } from './model'

afterEach(() => vi.unstubAllGlobals())

function render(target: TargetId = 'nsx', rules?: Rule[], theme?: string) {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => key === 'fwgen.theme' ? theme ?? null : key === 'fwgen.v2' && rules
      ? JSON.stringify({ target, rules, policyName: 'test-policy', nsxProject: 'project-one', nsxCategory: 'Environment' })
      : null,
  })
  return renderToStaticMarkup(<App />)
}

describe('policy workspace', () => {
  it('starts light-first and still offers the saved dark theme', () => {
    expect(render()).toContain('<span>Dark</span>')
    expect(render('nsx', undefined, 'dark')).toContain('<span>Light</span>')
  })

  it('exposes real workspace controls, accessible search, and upcoming navigation', () => {
    const html = render()
    for (const text of ['Policy builder', 'Policy rules', 'Rule details', 'Generated output', 'Search rules', 'Policy summary', 'Import', 'Export', 'Share link', 'Copy code']) {
      expect(html).toContain(text)
    }
    expect(html).toMatch(/disabled=""[^>]*aria-label="Templates \(upcoming\)"/)
    expect(html).toContain('aria-labelledby="import-heading"')
    expect(html).toContain('Rules to import as CSV')
    for (const platform of PLATFORMS) expect(html).toContain(`value="${platform.platform}"`)
  })

  for (const target of TARGETS) {
    it(`keeps ${target.id} selectable and exposes every target-specific field`, () => {
      const html = render(target.id, [{ ...blankRule(), name: 'first' }])
      for (const format of TARGETS.filter((t) => t.platform === target.platform)) {
        expect(html).toContain(`value="${format.id}"`)
      }
      for (const key of EXTRA_COLUMNS[target.id]) {
        expect(html).toContain(`aria-label="${COLUMNS[key].title ?? COLUMNS[key].label} for first"`)
      }
      expect(html).toContain(target.filename)
    })
  }

  it('retains saved policy and NSX scope settings', () => {
    const html = render('nsx', [{ ...blankRule(), name: 'saved-rule' }])
    expect(html).toContain('value="test-policy"')
    expect(html).toContain('value="project-one"')
    expect(html).toContain('<option selected="">Environment</option>')
    expect(html).toContain('saved-rule')
  })

  it('keeps empty-policy recovery and disables destructive actions', () => {
    const html = render('windows', [])
    expect(html).toContain('Start your policy')
    expect(html).toContain('Load example rules')
    expect(html).not.toContain('id="inspector-heading"')
    expect(html).toMatch(/disabled="">Export/)
    expect(html).toMatch(/disabled="">Clear all/)
  })

  it('shows disabled rules without including them in output and preserves their order', () => {
    const html = render('windows', [
      { ...blankRule(), name: 'first-rule', enabled: false },
      { ...blankRule(), name: 'second-rule' },
    ])
    const table = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'))
    expect(table.indexOf('first-rule')).toBeLessThan(table.indexOf('second-rule'))
    expect(table).toContain('selected off')
    const code = html.slice(html.indexOf('<pre'), html.indexOf('</pre>'))
    expect(code).not.toContain('first-rule')
    expect(code).toContain('second-rule')
  })
})
