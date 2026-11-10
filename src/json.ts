import { ROUTEROS_CHAINS, blankRule, newId, sampleRules } from './model'
import type { Rule, TargetId } from './model'
import { restoreSections, serializeSections } from './sections'
import type { SectionState } from './sections'

interface JsonMeta {
  target: TargetId
  policyName: string
  nsxProject?: string
  nsxCategory?: string
  sections?: SectionState
}
export interface JsonImport {
  rules: Rule[]
  error?: string
  sections?: SectionState
  warnings?: string[]
  meta?: Partial<Omit<JsonMeta, 'sections'>>
}

export type DataFormat = 'csv' | 'json'

const FORMAT_ID = 'firewall-forge-rules'

const ENUMS: Partial<Record<keyof Rule, readonly string[]>> = {
  action: ['ALLOW', 'DROP', 'REJECT'],
  direction: ['Inbound', 'Outbound'],
  protocol: ['TCP', 'UDP', 'ICMP', 'ANY'],
  profile: ['Any', 'Domain', 'Private', 'Public'],
  routerosChain: ROUTEROS_CHAINS,
}

// Lossless: every rule field is kept, including per-target options and the enabled switch.
export const toJson = (rules: Rule[], meta: JsonMeta): string =>
  JSON.stringify(
    { format: FORMAT_ID, version: 2, target: meta.target, policyName: meta.policyName, nsxProject: meta.nsxProject, nsxCategory: meta.nsxCategory, sections: serializeSections(rules, meta.sections), rules: rules.map(({ id: _id, ...rest }) => rest) },
    null,
    2,
  ) + '\n'

export const jsonExample = (meta: { target: TargetId; policyName: string }): string => toJson(sampleRules(), meta).trimEnd()

// Accepts the export format or a bare array. RouterOS imports reject invalid fields rather than silently changing packet flow.
export const parseJson = (text: string, target?: TargetId): JsonImport => {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { rules: [], error: `Not valid JSON: ${(e as Error).message}` }
  }
  const envelope = !Array.isArray(data) && data !== null && typeof data === 'object' ? data as Record<string, unknown> : undefined
  if (envelope?.format === FORMAT_ID && envelope.version !== 1 && envelope.version !== 2)
    return { rules: [], error: 'Unsupported Firewall Forge JSON version; no rules were imported.' }
  const list = Array.isArray(data) ? data : envelope?.rules
  if (!Array.isArray(list)) return { rules: [], error: 'Expected an array of rules or an object with a "rules" array.' }

  if (list.some((item) => item !== null && typeof item === 'object' && 'routerosChain' in item && !ROUTEROS_CHAINS.includes(item.routerosChain as Rule['routerosChain'])))
    return { rules: [], error: 'Invalid RouterOS chain: use Auto, input, forward or output.' }

  const defaults = blankRule() as unknown as Record<string, unknown>
  const exportTarget = !Array.isArray(data) ? (data as { target?: unknown } | null)?.target : undefined
  const routeros = target === 'mikrotik' || target === 'mikrotik-tf' || exportTarget === 'mikrotik' || exportTarget === 'mikrotik-tf'
  if (routeros) {
    for (const [index, item] of list.entries()) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return { rules: [], error: `Rule ${index + 1} must be an object.` }
      for (const key of Object.keys(defaults)) {
        if (key === 'id' || !(key in item)) continue
        const allowed = ENUMS[key as keyof Rule]
        if (typeof item[key] !== typeof defaults[key] || (allowed && !allowed.includes(item[key])))
          return { rules: [], error: `Rule ${index + 1}: invalid ${key}; correct the field before importing for RouterOS.` }
      }
    }
  }
  const rules = list
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
    .map((item) => {
      const out: Record<string, unknown> = { ...defaults, id: newId() }
      for (const key of Object.keys(defaults)) {
        if (key === 'id' || !(key in item)) continue
        const value = item[key]
        if (typeof value !== typeof defaults[key]) continue
        const allowed = ENUMS[key as keyof Rule]
        if (allowed && !allowed.includes(value as string)) continue
        out[key] = value
      }
      return out as unknown as Rule
    })
  if (!rules.length && list.length) return { rules: [], error: 'No rules found in the JSON.' }
  if (!rules.length && envelope?.sections === undefined) return { rules: [], error: 'No rules found in the JSON.' }
  const indexes = list.flatMap((item, index) => typeof item === 'object' && item !== null && !Array.isArray(item) ? [index] : [])
  const restored = envelope?.sections === undefined && envelope?.version !== 2 ? undefined : restoreSections(envelope?.sections ?? null, rules, indexes, list.length)
  const meta = envelope ? {
    target: typeof envelope.target === 'string' ? envelope.target as TargetId : undefined,
    policyName: typeof envelope.policyName === 'string' ? envelope.policyName : undefined,
    nsxProject: typeof envelope.nsxProject === 'string' ? envelope.nsxProject : undefined,
    nsxCategory: typeof envelope.nsxCategory === 'string' ? envelope.nsxCategory : undefined,
  } : undefined
  return { rules, ...restored, meta }
}
