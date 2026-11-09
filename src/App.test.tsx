import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import App from './App'
import { TARGETS } from './generators'
import { blankRule } from './model'

afterEach(() => vi.unstubAllGlobals())

describe('generated output', () => {
  it('starts expanded and contains the platform selectors and generated code', () => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'fwgen.theme' ? 'light' : null })

    const markup = renderToStaticMarkup(<App />)
    const output = markup.split('<section class="panel output">')[1].split('</section>')[0]
    expect(output).toContain('<details open=""><summary class="output-summary">Generated output</summary>')
    expect(output).toContain('aria-label="Firewall platform"')
    expect(output).toContain('<pre class="code">')
  })
})

describe.each(['mikrotik', 'mikrotik-tf'])('MikroTik editor (%s)', (target) => {
  const render = (overrides = {}) => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key === 'fwgen.theme' ? 'light' : key === 'fwgen.v2' ? JSON.stringify({ rules: [{ ...blankRule(), name: 'test', ...overrides }], target, policyName: 'test' }) : null,
    })
    return renderToStaticMarkup(<App />)
  }

  it('shows chain controls and explains their packet direction', () => {
    const markup = render()
    expect(markup).toContain('aria-label="RouterOS chain for test"')
    expect(markup).toContain('<option selected="">Auto</option>')
    expect(markup).toContain('<option>forward</option>')
    expect(markup).toContain('input = to router, output = from router, forward = through router')
    expect(markup).not.toContain('aria-label="Direction for test" disabled=""')
  })

  it('preserves but disables Direction for an explicit chain', () => {
    expect(render({ routerosChain: 'forward', direction: 'Outbound' })).toContain('aria-label="Direction for test" disabled=""')
    expect(render({ routerosChain: 'forward', direction: 'Outbound' })).toContain('<option selected="">Outbound</option>')
  })

  it('loads old stored rules with Auto and blocks invalid rule downloads', () => {
    expect(render({ routerosChain: undefined })).toContain('<option selected="">Auto</option>')
    const markup = render({ source: 'Internet' })
    expect(markup).toContain('Generation blocked: fix enabled-rule errors first.')
    expect(markup).toContain(`disabled="">Download mikrotik-firewall.${target === 'mikrotik-tf' ? 'tf' : 'rsc'}</button>`)
    expect(markup).toContain('disabled="">Copy</button>')
    expect(markup).toContain('BLOCKED:')
  })
})

describe('home logo', () => {
  it.each([
    ['light', 'icon-light.svg'],
    ['dark', 'icon.svg'],
  ])('links the %s theme icon to Firewall Forge home', (theme, icon) => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key === 'fwgen.theme' ? theme : null,
    })

    const markup = renderToStaticMarkup(<App />)
    expect(markup).toContain(
      `<a class="logo-link" href="https://firewall-forge.graa.dev" aria-label="Firewall Forge home"><img src="/${icon}" alt="" class="logo"/></a>`,
    )
  })

  describe('platform and output selectors', () => {
    it.each(TARGETS)('identifies the selected platform and $format format for $id', (target) => {
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => {
          if (key === 'fwgen.theme') return 'light'
          if (key === 'fwgen.v2') return JSON.stringify({ rules: [], target: target.id, policyName: 'test' })
          return null
        },
      })

      const markup = renderToStaticMarkup(<App />)
      const platformGroup = markup.split('aria-label="Firewall platform">')[1].split('</div>')[0]
      const formatGroup = markup.split('aria-label="Output format">')[1].split('</div>')[0]
      const formats = TARGETS.filter((t) => t.platform === target.platform)

      expect(platformGroup.match(/class="tab active" data-platform="[^"]+" aria-pressed="true"/g)).toHaveLength(1)
      expect(platformGroup).toContain(`class="tab active" data-platform="${target.platform}" aria-pressed="true"><span><span class="selection-mark" aria-hidden="true">✓ </span>${target.label}</span>`)
      expect(formatGroup.match(/class="format active" aria-pressed="true"/g)).toHaveLength(1)
      expect(formatGroup.match(/aria-pressed=/g)).toHaveLength(formats.length)
      expect(formatGroup).toContain(`</span>${target.format}</button>`)
    })
  })
})
