import type { Rule } from './model'
import type { Membership } from './grouping'

export interface SectionState {
  membership: Membership
  titles: Record<string, string>
  nsxSeparatePolicies: boolean
}

export interface SectionData {
  version: 1
  titles: Record<string, string>
  ruleSections: string[]
  nsxSeparatePolicies: boolean
}

export const emptySections = (): SectionState => ({ membership: {}, titles: { unsectioned: 'Unsectioned' }, nsxSeparatePolicies: false })
export const CSV_SECTION_NOTICE = 'CSV is rule-only: section names, membership and NSX policy layout are not included. Use JSON or a share link to preserve them. Imported CSV rules enter Unsectioned; existing sections are kept.'
const sectionWarning = 'Invalid or unsupported section metadata was ignored; affected rules are Unsectioned and the restored separate-policy layout is disabled. Rule order is unchanged. Review generated resource identities before applying.'
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const safeId = (value: string) => value.length > 0 && !['__proto__', 'constructor', 'prototype'].includes(value)

export function normalizeSections(rules: Rule[], state: SectionState): SectionState {
  const titles = Object.fromEntries(Object.entries(state.titles).filter(([id, title]) => safeId(id) && typeof title === 'string'))
  titles.unsectioned = 'Unsectioned'
  const membership = Object.fromEntries(rules.flatMap((rule) => {
    const group = Object.hasOwn(state.membership, rule.id) ? state.membership[rule.id] : undefined
    return group && group !== 'unsectioned' && Object.hasOwn(titles, group) ? [[rule.id, group]] : []
  }))
  return { membership, titles, nsxSeparatePolicies: state.nsxSeparatePolicies === true }
}

// Portable references use original array positions, not rule IDs (JSON/share imports regenerate IDs).
export function serializeSections(rules: Rule[], state: SectionState = emptySections()): SectionData {
  const normalized = normalizeSections(rules, state)
  return { version: 1, titles: normalized.titles, ruleSections: rules.map((rule) => Object.hasOwn(normalized.membership, rule.id) ? normalized.membership[rule.id]! : 'unsectioned'), nsxSeparatePolicies: normalized.nsxSeparatePolicies }
}

export function restoreSections(data: unknown, rules: Rule[], sourceIndexes = rules.map((_, index) => index), sourceCount = rules.length): { sections: SectionState; warnings: string[] } {
  if (data === undefined) return { sections: emptySections(), warnings: [] }
  if (!record(data) || data.version !== 1 || !record(data.titles) || !Array.isArray(data.ruleSections))
    return { sections: emptySections(), warnings: [sectionWarning] }
  let invalid = data.ruleSections.length !== sourceCount || typeof data.nsxSeparatePolicies !== 'boolean'
  const titles: Record<string, string> = Object.fromEntries(Object.entries(data.titles).flatMap(([id, title]) => {
    if (!safeId(id) || typeof title !== 'string' || (id === 'unsectioned' && title !== 'Unsectioned')) { invalid = true; return [] }
    return [[id, title]]
  }))
  titles.unsectioned = 'Unsectioned'
  const assignments = data.ruleSections
  const membership = Object.fromEntries(rules.flatMap((rule, index) => {
    const group: unknown = assignments[sourceIndexes[index]]
    if (typeof group !== 'string' || !Object.hasOwn(titles, group)) { invalid = true; return [] }
    return group === 'unsectioned' ? [] : [[rule.id, group]]
  }))
  return { sections: { titles, membership, nsxSeparatePolicies: !invalid && data.nsxSeparatePolicies === true }, warnings: invalid ? [sectionWarning] : [] }
}

export const hasSections = (rules: Rule[], state: SectionState) => Object.keys(normalizeSections(rules, state).titles).some((id) => id !== 'unsectioned') || state.nsxSeparatePolicies

export function appendSectionedRules(existing: Rule[], current: SectionState, incoming: Rule[], imported: SectionState): { rules: Rule[]; sections: SectionState; error?: string; warnings: string[] } {
  const kept = normalizeSections(existing, current)
  const added = normalizeSections(incoming, imported)
  if (!existing.length) return { rules: incoming, sections: added, warnings: [] }
  const conflict = Object.keys(added.titles).find((id) => id !== 'unsectioned' && Object.hasOwn(kept.titles, id))
  if (conflict) return { rules: existing, sections: kept, error: 'Imported section IDs overlap existing sections. Import into an empty workspace or open a share link to replace the workspace; no rules were added.', warnings: [] }
  return {
    rules: [...existing, ...incoming],
    sections: { titles: { ...kept.titles, ...added.titles }, membership: { ...kept.membership, ...added.membership }, nsxSeparatePolicies: kept.nsxSeparatePolicies },
    warnings: kept.nsxSeparatePolicies !== added.nsxSeparatePolicies ? ['Existing NSX policy layout was kept when appending JSON. Review the combined rule order and generated output.'] : [],
  }
}
