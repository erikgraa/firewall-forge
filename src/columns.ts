import type { Rule, TargetId } from './model'

export type ColKey = 'logging' | 'priority' | 'profile' | 'program' | 'zone' | 'scope' | 'notes' | 'srcZone' | 'dstZone' | 'permanent'

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
  permanent: { label: 'Permanent', width: '84px', title: 'Permanent rules survive a reload; unticked = runtime only' },
  zone: { label: 'Zone', width: '96px', title: 'firewalld zone (blank = public)' },
  scope: { label: 'Applied to', width: 'minmax(120px, 1fr)', title: 'NSX group path the policy applies to' },
  notes: { label: 'Notes', width: 'minmax(120px, 1fr)' },
  srcZone: { label: 'From zone', width: '100px', title: 'Source zone (Palo Alto / Cisco FMC); blank = any' },
  dstZone: { label: 'To zone', width: '100px', title: 'Destination zone (Palo Alto / Cisco FMC); blank = any' },
}

export const EXTRA_COLUMNS: Record<TargetId, ColKey[]> = {
  nsx: ['scope', 'logging', 'notes'],
  'nsx-ps': ['scope', 'logging', 'notes'],
  'nsx-sdk': ['scope', 'logging', 'notes'],
  'sdn-ps': ['priority', 'logging'],
  'azl-nsg': ['priority'],
  'azl-bicep': ['priority', 'notes'],
  'azfw-tf': [],
  'azfw-bicep': ['notes'],
  windows: ['profile', 'program'],
  firewalld: ['zone', 'permanent', 'logging'],
  'firewalld-ansible': ['zone', 'permanent', 'logging'],
  cisco: ['logging'],
  'cisco-ansible': ['logging'],
  'cisco-tf': ['logging'],
  nftables: ['logging'],
  'nftables-ansible': ['logging'],
  iptables: ['logging'],
  'iptables-ansible': ['logging'],
  fmc: ['srcZone', 'dstZone', 'logging', 'notes'],
  panos: ['srcZone', 'dstZone', 'logging', 'notes'],
  'panos-1x': ['srcZone', 'dstZone', 'logging', 'notes'],
  'panos-ansible': ['srcZone', 'dstZone', 'logging', 'notes'],
}

export const hasExtra = (rule: Rule, key: ColKey) => Boolean(rule[key])
