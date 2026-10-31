export type Action = 'ALLOW' | 'DROP' | 'REJECT'
export type Direction = 'Inbound' | 'Outbound'
export type Protocol = 'TCP' | 'UDP' | 'ICMP' | 'ANY'
export type TargetId = 'nsx' | 'sdn-ps' | 'sdn-json' | 'azl-nsg' | 'firewalld' | 'windows' | 'cisco' | 'panos'

export interface Rule {
  id: string
  enabled: boolean
  name: string
  source: string
  destination: string
  service: string
  protocol: Protocol
  ports: string
  action: Action
  direction: Direction
  logging: boolean
  priority: string
  profile: 'Any' | 'Domain' | 'Private' | 'Public'
  program: string
  zone: string
  scope: string
  notes: string
  srcZone: string
  dstZone: string
}

export interface Endpoint {
  nsx: string[]
  net: string[]
}

export interface Service {
  protocol: Protocol
  ports: string
  nsx: string | null
}

export const CUSTOM = 'Custom'

export const ENDPOINTS: Record<string, Endpoint> = {
  Any: { nsx: [], net: ['*'] },
  Internet: { nsx: ['0.0.0.0/0'], net: ['Internet'] },
  'Private networks (RFC1918)': {
    nsx: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
    net: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
  },
  'Public DNS (1.1.1.1, 8.8.8.8)': { nsx: ['1.1.1.1', '8.8.8.8'], net: ['1.1.1.1', '8.8.8.8'] },
}

export const SERVICES: Record<string, Service> = {
  'HTTP (TCP 80)': { protocol: 'TCP', ports: '80', nsx: 'HTTP' },
  'HTTPS (TCP 443)': { protocol: 'TCP', ports: '443', nsx: 'HTTPS' },
  'SSH (TCP 22)': { protocol: 'TCP', ports: '22', nsx: 'SSH' },
  'RDP (TCP 3389)': { protocol: 'TCP', ports: '3389', nsx: 'RDP' },
  'DNS (UDP 53)': { protocol: 'UDP', ports: '53', nsx: 'DNS-UDP' },
  'DNS (TCP 53)': { protocol: 'TCP', ports: '53', nsx: 'DNS' },
  'NTP (UDP 123)': { protocol: 'UDP', ports: '123', nsx: 'NTP' },
  'LDAP (TCP 389)': { protocol: 'TCP', ports: '389', nsx: 'LDAP' },
  'LDAPS (TCP 636)': { protocol: 'TCP', ports: '636', nsx: 'LDAP-over-SSL' },
  'Kerberos (TCP 88)': { protocol: 'TCP', ports: '88', nsx: null },
  'SMB (TCP 445)': { protocol: 'TCP', ports: '445', nsx: null },
  'WinRM (TCP 5985-5986)': { protocol: 'TCP', ports: '5985-5986', nsx: null },
  'MS SQL (TCP 1433)': { protocol: 'TCP', ports: '1433', nsx: 'MS-SQL-S' },
  'ICMP (all)': { protocol: 'ICMP', ports: '', nsx: 'ICMP-ALL' },
}

let counter = 0
export const newId = () => `r${Date.now().toString(36)}${(counter++).toString(36)}`

export const blankRule = (): Rule => ({
  id: newId(),
  enabled: true,
  name: '',
  source: 'Any',
  destination: 'Any',
  service: 'HTTPS (TCP 443)',
  protocol: 'TCP',
  ports: '443',
  action: 'ALLOW',
  direction: 'Inbound',
  logging: false,
  priority: '',
  profile: 'Any',
  program: '',
  zone: '',
  scope: '',
  notes: '',
  srcZone: '',
  dstZone: '',
})

export const sampleRules = (): Rule[] => [
  { ...blankRule(), name: 'web-in', source: 'Private networks (RFC1918)', destination: '10.10.10.0/24' },
  {
    ...blankRule(),
    name: 'dns-out',
    source: 'Any',
    destination: 'Public DNS (1.1.1.1, 8.8.8.8)',
    service: 'DNS (UDP 53)',
    protocol: 'UDP',
    ports: '53',
    direction: 'Outbound',
  },
  { ...blankRule(), name: 'deny-rest', service: CUSTOM, protocol: 'ANY', ports: '', action: 'DROP' },
]

export const applyService = (rule: Rule, service: string): Rule => {
  if (service === CUSTOM) return { ...rule, service }
  const s = SERVICES[service]
  return { ...rule, service, protocol: s.protocol, ports: s.ports }
}
