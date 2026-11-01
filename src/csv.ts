import { CUSTOM, SERVICES, applyService, blankRule, sampleRules } from './model'
import type { Action, Direction, Protocol, Rule } from './model'
import type { ColKey } from './columns'

const protocols: Protocol[] = ['TCP', 'UDP', 'ICMP', 'ANY']
const profiles = ['Any', 'Domain', 'Private', 'Public'] as const

export const BASE_FIELDS = ['name', 'source', 'destination', 'service', 'ports', 'action', 'direction'] as const
const EXTRA_FIELDS: ColKey[] = ['logging', 'priority', 'profile', 'program', 'zone', 'scope', 'notes', 'srcZone', 'dstZone', 'permanent']
const FIELD_LOOKUP = new Map<string, string>([...BASE_FIELDS, ...EXTRA_FIELDS].map((f) => [f.toLowerCase(), f]))

// The columns of the selected target: shared fields first, then that target's own options.
export const csvColumns = (extras: ColKey[]): string[] => [...BASE_FIELDS, ...extras]

const splitLine = (line: string): string[] =>
  line.split(/\t|;|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.trim().replace(/^"|"$/g, '').replace(/""/g, '"'))

const truthy = (v: string | undefined, fallback: boolean) => (v === undefined || v === '' ? fallback : /^(true|yes|y|1|on|x)$/i.test(v.trim()))

// A header row maps columns by name (any order, unknown columns ignored). Without one, columns are positional for the given target.
export const parseCsv = (text: string, extras: ColKey[] = []): Rule[] => {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(splitLine)
  if (!rows.length) return []
  const known = rows[0].filter((c) => FIELD_LOOKUP.has(c.trim().toLowerCase())).length
  const hasHeader = known >= 2 && rows[0].some((c) => /^name$/i.test(c.trim()))
  const header = hasHeader ? rows[0].map((h) => FIELD_LOOKUP.get(h.trim().toLowerCase()) ?? '') : csvColumns(extras)

  return rows.slice(hasHeader ? 1 : 0).map((cells) => {
    const get = (field: string): string | undefined => {
      const i = header.indexOf(field)
      return i >= 0 ? cells[i] : undefined
    }
    const act = (get('action') ?? 'ALLOW').toUpperCase()
    const proto = (get('service') ?? '').toUpperCase() as Protocol
    const svc = get('service') ?? ''
    let rule: Rule = {
      ...blankRule(),
      name: get('name') ?? '',
      source: get('source') || 'Any',
      destination: get('destination') || 'Any',
      action: (['ALLOW', 'DROP', 'REJECT'].includes(act) ? act : 'ALLOW') as Action,
      direction: (/^out/i.test(get('direction') ?? '') ? 'Outbound' : 'Inbound') as Direction,
      logging: truthy(get('logging'), false),
      permanent: truthy(get('permanent'), true),
      program: get('program') ?? '',
      zone: get('zone') ?? '',
      scope: get('scope') ?? '',
      notes: get('notes') ?? '',
      srcZone: get('srcZone') ?? '',
      dstZone: get('dstZone') ?? '',
      priority: /^\d+$/.test((get('priority') ?? '').trim()) ? (get('priority') ?? '').trim() : '',
      profile: profiles.find((p) => p.toLowerCase() === (get('profile') ?? '').toLowerCase()) ?? 'Any',
    }
    rule = SERVICES[svc]
      ? applyService(rule, svc)
      : { ...rule, service: CUSTOM, protocol: protocols.includes(proto) ? proto : 'ANY', ports: get('ports') ?? '' }
    return rule
  })
}

const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

const cell = (r: Rule, field: string): string => {
  switch (field) {
    case 'service':
      return r.service !== CUSTOM ? r.service : r.protocol
    case 'ports':
      return r.service !== CUSTOM ? '' : r.ports
    case 'logging':
      return String(r.logging)
    case 'permanent':
      return String(r.permanent)
    default:
      return String(r[field as keyof Rule] ?? '')
  }
}

export const toCsv = (rules: Rule[], extras: ColKey[] = []): string => {
  const cols = csvColumns(extras)
  return [cols.join(','), ...rules.map((r) => cols.map((c) => quote(cell(r, c))).join(','))].join('\n') + '\n'
}

export const csvExample = (extras: ColKey[] = []): string => toCsv(sampleRules(), extras).trimEnd()
