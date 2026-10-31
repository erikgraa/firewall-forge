import { SERVICES } from './model'
import type { Rule } from './model'

export interface Issue {
  level: 'error' | 'warn'
  message: string
}

const cidr = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/
const portRe = /^\d{1,5}(-\d{1,5})?$/

export const validate = (rules: Rule[]): Issue[] => {
  const issues: Issue[] = []
  const names = new Map<string, number>()
  rules.forEach((r, i) => {
    const label = r.name || `Rule ${i + 1}`
    if (!r.name.trim()) issues.push({ level: 'error', message: `Rule ${i + 1} has no name` })
    names.set(r.name, (names.get(r.name) ?? 0) + 1)
    if (r.ports.trim()) {
      for (const p of r.ports.split(',')) {
        const t = p.trim()
        if (!portRe.test(t)) issues.push({ level: 'error', message: `${label}: invalid port "${t}"` })
        else if (t.split('-').some((n) => Number(n) > 65535))
          issues.push({ level: 'error', message: `${label}: port out of range "${t}"` })
      }
    }
    for (const [field, value] of [['source', r.source], ['destination', r.destination]] as const) {
      if (/^\d/.test(value.trim())) {
        for (const part of value.split(',')) {
          const t = part.trim()
          const octetsOk = t.split('/')[0].split('.').every((o) => Number(o) <= 255)
          if (!cidr.test(t) || !octetsOk) issues.push({ level: 'error', message: `${label}: invalid ${field} address "${t}"` })
        }
      }
    }
    if (r.service !== 'Custom' && !SERVICES[r.service]) issues.push({ level: 'error', message: `${label}: unknown service` })
    if (r.priority.trim() && !/^\d+$/.test(r.priority.trim()))
      issues.push({ level: 'error', message: `${label}: priority must be a whole number` })
    if (r.enabled && r.action === 'ALLOW' && r.source === 'Any' && r.destination === 'Any' && !r.ports.trim())
      issues.push({ level: 'warn', message: `${label}: allow any → any on all ports` })
  })
  for (const [name, n] of names) if (name && n > 1) issues.push({ level: 'error', message: `Duplicate rule name "${name}"` })

  const firstDrop = rules.findIndex((r) => r.enabled && r.action !== 'ALLOW' && r.source === 'Any' && r.destination === 'Any' && !r.ports.trim())
  if (firstDrop >= 0 && firstDrop < rules.length - 1)
    issues.push({ level: 'warn', message: `"${rules[firstDrop].name}" is a catch-all drop but is not the last rule — later rules never match` })
  return issues
}
