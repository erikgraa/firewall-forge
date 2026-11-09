import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import App from './App'

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
})
