import { applyService, blankRule } from './model'
import type { Rule } from './model'

export type Membership = Record<string, string>
export interface RuleEntry { rule: Rule; index: number }
export interface RuleSection { key: string; group: string; continued: boolean; entries: RuleEntry[] }
export const sectionNames = ['Management access', 'Application traffic', 'DNS & time', 'Internal services', 'Restricted networks']
const prefixes = ['admin', 'apps', 'dns', 'services', 'deny']

export function demoRules(): Rule[] {
  return sectionNames.flatMap((_, group) => Array.from({ length: 6 }, (_, index) => {
    const service = group === 0 ? 'SSH (TCP 22)' : group === 2 ? index % 2 ? 'NTP (UDP 123)' : 'DNS (UDP 53)' : group === 3 ? 'LDAPS (TCP 636)' : 'HTTPS (TCP 443)'
    return {
      ...applyService(blankRule(), service),
      name: `${prefixes[group]}-${String(index + 1).padStart(2, '0')}`,
      source: `10.${10 + group}.${index + 1}.0/24`,
      destination: group === 4 ? 'Any' : `10.${50 + group}.0.${index + 1}`,
      action: group === 4 ? index === 5 ? 'REJECT' as const : 'DROP' as const : 'ALLOW' as const,
      enabled: !(group === 1 && index === 5),
      routerosChain: 'forward' as const,
      notes: 'Isolated grouping preview sample — not a deployment recommendation.',
    }
  }))
}

export function initialMembership(rules: Rule[]): Membership {
  return Object.fromEntries(rules.map((rule) => {
    const group = prefixes.findIndex((prefix) => rule.name.startsWith(`${prefix}-`))
    return [rule.id, group < 0 ? 'unsectioned' : `demo-${group}`]
  }))
}

export function sectionRuns(rules: Rule[], membership: Membership): RuleSection[] {
  const runs: RuleSection[] = []
  const seen = new Set<string>()
  rules.forEach((rule, index) => {
    const group = membership[rule.id] ?? 'unsectioned'
    let run = runs[runs.length - 1]
    if (!run || run.group !== group) {
      run = { key: rule.id, group, continued: seen.has(group), entries: [] }
      seen.add(group)
      runs.push(run)
    }
    run.entries.push({ rule, index })
  })
  return runs
}

export function splitAt(rules: Rule[], membership: Membership, startId: string, group: string): Membership {
  const start = rules.findIndex((rule) => rule.id === startId)
  if (start < 0) return membership
  const previous = membership[startId] ?? 'unsectioned'
  const next = { ...membership }
  for (let index = start; index < rules.length && (membership[rules[index].id] ?? 'unsectioned') === previous; index++) next[rules[index].id] = group
  return next
}

export function mergePrevious(rules: Rule[], membership: Membership, key: string): Membership {
  const runs = sectionRuns(rules, membership)
  const index = runs.findIndex((run) => run.key === key)
  if (index <= 0) return membership
  const next = { ...membership }
  for (const { rule } of runs[index].entries) next[rule.id] = runs[index - 1].group
  return next
}
