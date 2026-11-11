import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const host = readFileSync(new URL('../public/CNAME', import.meta.url), 'utf8').trim()
const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1]
const metadata = new Map([...html.matchAll(/<meta (?:name|property)="([^"]+)" content="([^"]+)"/g)].map((match) => [match[1], match[2]]))

function meta(key: string) {
  const value = metadata.get(key)
  if (!value) throw new Error(`Missing static metadata: ${key}`)
  return value
}

describe('static social previews', () => {
  it('provides consistent titles and descriptions without running the app', () => {
    const title = html.match(/<title>([^<]+)<\/title>/)?.[1]
    expect(title).toBe('Firewall Forge')
    expect(meta('og:title')).toBe(title)
    expect(meta('twitter:title')).toBe(title)
    expect(meta('og:site_name')).toBe(title)
    expect(meta('description')).toContain('Browser-only')
    expect(meta('og:description')).toBe(meta('description'))
    expect(meta('twitter:description')).toBe(meta('description'))
    expect(meta('og:type')).toBe('website')
    expect(meta('twitter:card')).toBe('summary_large_image')
  })

  it('uses the production canonical origin rather than shared-rule parameters or relative asset paths', () => {
    expect(host).toBe('firewallforge.graa.dev')
    expect(canonical).toBe(`https://${host}/`)
    expect(meta('og:url')).toBe(canonical)
    expect(meta('og:image')).toBe(`https://${host}/social-preview.png`)
    expect(meta('twitter:image')).toBe(meta('og:image'))
    for (const url of [canonical!, meta('og:url'), meta('og:image'), meta('twitter:image')]) {
      const parsed = new URL(url)
      expect(parsed.protocol).toBe('https:')
      expect(parsed.search).toBe('')
      expect(parsed.hash).toBe('')
    }
  })

  it('ships a PNG with the declared dimensions and matching accessible descriptions', () => {
    const png = readFileSync(new URL('../public/social-preview.png', import.meta.url))
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR')
    expect(png.readUInt32BE(16)).toBe(Number(meta('og:image:width')))
    expect(png.readUInt32BE(20)).toBe(Number(meta('og:image:height')))
    expect(png.readUInt32BE(16)).toBe(1200)
    expect(png.readUInt32BE(20)).toBe(630)
    expect(png.length).toBeLessThan(5 * 1024 * 1024)
    expect(meta('og:image:type')).toBe('image/png')
    expect(meta('og:image:alt')).toContain('Firewall Forge logo')
    expect(meta('twitter:image:alt')).toBe(meta('og:image:alt'))
  })
})
