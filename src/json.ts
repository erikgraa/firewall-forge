import { ROUTEROS_CHAINS, blankRule, newId, sampleRules } from './model'
import type { Rule, TargetId } from './model'

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
export const toJson = (rules: Rule[], meta: { target: TargetId; policyName: string }): string =>
  JSON.stringify(
    { format: FORMAT_ID, version: 1, target: meta.target, policyName: meta.policyName, rules: rules.map(({ id: _id, ...rest }) => rest) },
    null,
    2,
  ) + '\n'

export const jsonExample = (meta: { target: TargetId; policyName: string }): string => toJson(sampleRules(), meta).trimEnd()

// Accepts the export format or a bare array. RouterOS imports reject invalid fields rather than silently changing packet flow.
export const parseJson = (text: string, target?: TargetId): { rules: Rule[]; error?: string } => {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { rules: [], error: `Not valid JSON: ${(e as Error).message}` }
  }
  const list = Array.isArray(data) ? data : (data as { rules?: unknown } | null)?.rules
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
  return rules.length ? { rules } : { rules: [], error: 'No rules found in the JSON.' }
}
