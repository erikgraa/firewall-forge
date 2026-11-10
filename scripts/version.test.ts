import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as { version: string; packages: Record<string, { version: string }> }

describe('app release version', () => {
  it('injects the package version through the shared Vite build source', () => {
    expect(__APP_VERSION__).toBe(pkg.version)
  })

  it('keeps the package and both root lockfile versions consistent', () => {
    expect(lock.version).toBe(pkg.version)
    expect(lock.packages[''].version).toBe(pkg.version)
  })

  it('links the README badge to repository releases and records the matching changelog baseline', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    expect(readme).toContain('[![GitHub release](https://img.shields.io/github/v/release/erikgraa/firewall-forge?label=release)](https://github.com/erikgraa/firewall-forge/releases)')
    expect(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')).toContain(`## [${pkg.version}]`)
  })
})
