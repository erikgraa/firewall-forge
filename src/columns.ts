import type { Rule, TargetId } from './model'

export type ColKey = 'logging' | 'priority' | 'profile' | 'program' | 'zone' | 'scope' | 'notes'

export interface ColMeta {
  label: string
  width: string
  title?: string
}

export const COLUMNS: Record<ColKey, ColMeta> = {
  logging: { label: 'Log', width: '50px', title: 'Log matching traffic' },
  priority: { label: 'Priority', width: '84px', title: 'Explicit priority (blank = auto, in list order)' },
  profile: { label: 'Profile', width: '96px', title: 'Windows firewall profile' },
  program: { label: 'Program', width: 'minmax(120px, 1fr)', title: 'Optional executable path' },
  zone: { label: 'Zone', width: '96px', title: 'firewalld zone (blank = public)' },
  scope: { label: 'Applied to', width: 'minmax(120px, 1fr)', title: 'NSX group path the policy applies to' },
  notes: { label: 'Notes', width: 'minmax(120px, 1fr)' },
}

export const EXTRA_COLUMNS: Record<TargetId, ColKey[]> = {
  nsx: ['scope', 'logging', 'notes'],
  'sdn-ps': ['priority', 'logging'],
  'sdn-json': ['priority', 'logging'],
  'azl-nsg': ['priority'],
  windows: ['profile', 'program'],
  firewalld: ['zone', 'logging'],
  cisco: ['logging'],
}

export const hasExtra = (rule: Rule, key: ColKey) => Boolean(rule[key])
