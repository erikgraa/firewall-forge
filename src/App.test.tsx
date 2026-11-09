import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import App from './App'
import { TARGETS } from './generators'

afterEach(() => vi.unstubAllGlobals())

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

      expect(platformGroup.match(/class="tab active" aria-pressed="true"/g)).toHaveLength(1)
      expect(platformGroup).toContain(`class="tab active" aria-pressed="true"><span><span class="selection-mark" aria-hidden="true">✓ </span>${target.label}</span>`)
      expect(formatGroup.match(/class="format active" aria-pressed="true"/g)).toHaveLength(1)
      expect(formatGroup.match(/aria-pressed=/g)).toHaveLength(formats.length)
      expect(formatGroup).toContain(`</span>${target.format}</button>`)
    })
  })
})
