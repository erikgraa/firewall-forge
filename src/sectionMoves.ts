import type { Membership } from './grouping'
import type { Rule } from './model'

const groupOf = (membership: Membership, id: string) => Object.hasOwn(membership, id) ? membership[id] ?? 'unsectioned' : 'unsectioned'

export function moveRuleToSection(rules: Rule[], membership: Membership, ruleId: string, groupId: string): {
  rules: Rule[]; membership: Membership; fromIndex: number; toIndex: number
} {
  const fromIndex = rules.findIndex((rule) => rule.id === ruleId)
  if (fromIndex < 0 || !groupId.trim()) return { rules, membership, fromIndex: -1, toIndex: -1 }
  const remaining = rules.filter((_, index) => index !== fromIndex)
  const lastMember = remaining.findLastIndex((rule) => groupOf(membership, rule.id) === groupId)
  const toIndex = lastMember < 0 ? remaining.length : lastMember + 1
  const next = [...remaining]
  next.splice(toIndex, 0, rules[fromIndex])
  return { rules: next, membership: { ...membership, [ruleId]: groupId }, fromIndex, toIndex }
}

export function reorderRuleWithinSection(rules: Rule[], membership: Membership, ruleId: string, anchorId: string, placement: 'before' | 'after'): {
  rules: Rule[]; fromIndex: number; toIndex: number
} {
  const fromIndex = rules.findIndex((rule) => rule.id === ruleId)
  const anchorIndex = rules.findIndex((rule) => rule.id === anchorId)
  const noOp = { rules, fromIndex: -1, toIndex: -1 }
  if (fromIndex < 0 || anchorIndex < 0 || ruleId === anchorId || !['before', 'after'].includes(placement)) return noOp
  const group = groupOf(membership, ruleId)
  const span = rules.slice(Math.min(fromIndex, anchorIndex), Math.max(fromIndex, anchorIndex) + 1)
  if (span.some((rule) => groupOf(membership, rule.id) !== group)) return noOp
  const remaining = rules.filter((_, index) => index !== fromIndex)
  const toIndex = remaining.findIndex((rule) => rule.id === anchorId) + (placement === 'after' ? 1 : 0)
  const next = [...remaining]
  next.splice(toIndex, 0, rules[fromIndex])
  return { rules: next, fromIndex, toIndex }
}

export function appendToUnsectioned(rules: Rule[], added: Rule[], membership: Membership): Rule[] {
  const lastMember = rules.findLastIndex((rule) => groupOf(membership, rule.id) === 'unsectioned')
  const index = lastMember < 0 ? rules.length : lastMember + 1
  return [...rules.slice(0, index), ...added, ...rules.slice(index)]
}
