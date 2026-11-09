import { routerosChain } from './model'
import type { Rule, TargetId } from './model'
import { validate } from './validate'

export interface TopologyOptions { search: string; chain: string; showDisabled: boolean }
export const topologyContext = (rule: Rule, target: TargetId) => target === 'mikrotik' || target === 'mikrotik-tf' ? routerosChain(rule) : 'policy'
export const topologyErrors = (rule: Rule, target: TargetId, duplicateNames: ReadonlySet<string> = new Set()) => [
  ...validate([{ ...rule, enabled: true }], target).filter((issue) => issue.level === 'error').map((issue) => issue.message),
  ...(!rule.source.trim() || !rule.destination.trim() ? ['Complete both address matchers; empty values are not drawn as Any.'] : []),
  ...(duplicateNames.has(rule.name) ? [`Duplicate rule name "${rule.name}"`] : []),
]
export const projectTopology = (rules: Rule[], target: TargetId, options: TopologyOptions) => {
  const search = options.search.trim().toLowerCase()
  const routeros = target === 'mikrotik' || target === 'mikrotik-tf'
  const names = new Set<string>()
  const duplicateNames = new Set<string>()
  for (const rule of rules) {
    if (routeros && !rule.enabled) continue
    if (names.has(rule.name)) duplicateNames.add(rule.name)
    names.add(rule.name)
  }
  const errors = new Map(rules.map((rule) => [rule.id, topologyErrors(rule, target, duplicateNames)]))
  const matching = rules.map((rule, index) => ({ rule, order: index + 1 })).filter(({ rule }) => [rule.name, rule.source, rule.destination].some((value) => value.toLowerCase().includes(search)))
  const candidates = matching.filter(({ rule }) => (rule.enabled || options.showDisabled) && (!routeros || options.chain === 'all' || topologyContext(rule, target) === options.chain))
  const routes = candidates.filter(({ rule }) => !errors.get(rule.id)!.length).map(({ rule, order }) => ({ id: rule.id, rule, order, context: topologyContext(rule, target) }))
  const nodes = (role: 'source' | 'destination') => [...new Set(routes.map(({ rule }) => rule[role].trim()))].map((value) => ({ id: `${role}:${value}`, value }))
  return { routes, sources: nodes('source'), destinations: nodes('destination'), matching: matching.map(({ rule }) => rule), errors, invalid: candidates.length - routes.length }
}
