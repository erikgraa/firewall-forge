import { ENDPOINTS, SERVICES } from './model'
import type { Rule, TargetId } from './model'

export interface Issue {
  level: 'error' | 'warn'
  message: string
}

const cidr = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/
const portRe = /^\d{1,5}(-\d{1,5})?$/

export const validate = (rules: Rule[], target?: TargetId): Issue[] => {
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
  if (target) issues.push(...targetWarnings(rules.filter((r) => r.enabled), target))
  return issues
}

const isIp = (s: string) => cidr.test(s)
const ENDPOINT_NAMES = new Set(Object.keys(ENDPOINTS))
const nameOnly = (v: string) => !ENDPOINT_NAMES.has(v.trim()) && v.split(/\s*,\s*/).some((x) => x && !isIp(x))

const targetWarnings = (rules: Rule[], target: TargetId): Issue[] => {
  const warn = (message: string): Issue => ({ level: 'warn', message })
  const out: Issue[] = []
  const rejects = rules.filter((r) => r.action === 'REJECT')
  const named = rules.filter((r) => nameOnly(r.source) || nameOnly(r.destination))
  const quoted = (rs: Rule[]) => rs.map((r) => `"${r.name}"`).join(', ')

  const denyWord: Partial<Record<TargetId, string>> = {
    windows: 'Block',
    cisco: 'deny',
    'sdn-ps': 'Deny',
    'azl-nsg': 'Deny',
    'azl-bicep': 'Deny',
  }
  if (denyWord[target] && rejects.length)
    out.push(warn(`This target has no reject action — ${quoted(rejects)} will be emitted as ${denyWord[target]} (silently dropped).`))

  if (target === 'windows' && rules.some((r) => r.action === 'ALLOW') && rules.some((r) => r.action !== 'ALLOW'))
    out.push(warn('Windows Firewall evaluates Block rules before Allow rules regardless of order — a block can override an allow listed above it.'))

  if (['cisco', 'iptables', 'nftables'].includes(target) && rules.some((r) => r.protocol === 'ICMP' && r.ports.trim()))
    out.push(warn('ICMP rules ignore ports on this target (types/codes are not modelled).'))

  if (['cisco', 'firewalld', 'nftables', 'iptables', 'windows'].includes(target) && named.length)
    out.push(warn(`Names instead of IP/CIDR values (${quoted(named)}) cannot be resolved on this target; a TODO is generated.`))

  if (['nftables', 'iptables'].includes(target)) {
    const last = rules[rules.length - 1]
    if (!last || last.action === 'ALLOW')
      out.push(warn('Chains default to ACCEPT — add a final catch-all drop rule if you want default-deny.'))
  }

  if (['fmc', 'panos'].includes(target) && rules.some((r) => r.direction === 'Outbound'))
    out.push(warn('Direction is not used on this target (stateful, zone-based) — set the From/To zones instead.'))

  if (['sdn-ps', 'azl-nsg', 'azl-bicep'].includes(target)) {
    const p = rules.map((r) => Number(r.priority)).filter(Boolean)
    if (new Set(p).size !== p.length) out.push(warn('Two rules share the same explicit priority; priorities must be unique.'))
  }
  return out
}
