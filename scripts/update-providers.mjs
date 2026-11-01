// Refreshes src/providers.json with the latest release of each provider's pinned major version.
// Never fails the build: if the registry is unreachable the committed versions are kept.
import { readFileSync, writeFileSync } from 'node:fs'

const file = new URL('../src/providers.json', import.meta.url)
const providers = JSON.parse(readFileSync(file, 'utf8'))
const cache = new Map()

const versionsOf = async (source) => {
  if (!cache.has(source)) {
    const res = await fetch(`https://registry.terraform.io/v1/providers/${source}/versions`, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    cache.set(source, (await res.json()).versions.map((v) => v.version))
  }
  return cache.get(source)
}

const cmp = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number))
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

let changed = false
for (const [key, p] of Object.entries(providers)) {
  try {
    const stable = (await versionsOf(p.source)).filter((v) => /^\d+\.\d+\.\d+$/.test(v) && Number(v.split('.')[0]) === p.major)
    if (!stable.length) continue
    const latest = stable.sort(cmp).at(-1)
    const next = latest.split('.').slice(0, 2).join('.')
    if (cmp(`${next}.0`, `${p.version}.0`) > 0) {
      console.log(`${key}: ${p.version} -> ${next} (latest ${latest})`)
      p.version = next
      changed = true
    } else {
      console.log(`${key}: ${p.version} (latest ${latest})`)
    }
  } catch (e) {
    console.warn(`${key}: keeping ${p.version} (${e.message})`)
  }
}
if (changed) writeFileSync(file, JSON.stringify(providers, null, 2) + '\n')
