import { CUSTOM, ENDPOINTS, ROUTEROS_CHAINS, SERVICES, routerosChain } from './model'
import type { Rule } from './model'
import { requiredProviders } from './providers'

interface RouterosIssue {
  level: 'error' | 'warn'
  message: string
}

const ipv4 = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})(?:\/(0|[1-9]\d?))?$/
const validAddress = (value: string): boolean => {
  const match = ipv4.exec(value)
  return !!match && match.slice(1, 5).every((octet) => Number(octet) <= 255) && (match[5] === undefined || Number(match[5]) <= 32)
}

const addresses = (value: string): string[] => {
  const text = value.trim()
  return ENDPOINTS[text]?.net ?? text.split(',').map((part) => part.trim())
}

const allAddresses = (value: string): boolean => {
  const parts = addresses(value)
  return parts.length === 1 && (parts[0] === '*' || (validAddress(parts[0]) && parts[0].endsWith('/0')))
}
const catchAll = (rule: Rule): boolean => allAddresses(rule.source) && allAddresses(rule.destination) && rule.protocol === 'ANY' && !rule.ports.trim()

export const routerosIssues = (rules: Rule[], format: 'rsc' | 'terraform' = 'rsc'): RouterosIssue[] => {
  const enabled = rules.filter((rule) => rule.enabled)
  const issues: RouterosIssue[] = []
  const names = new Set<string>()
  const error = (message: string) => issues.push({ level: 'error', message })
  const warn = (message: string) => issues.push({ level: 'warn', message })
  enabled.forEach((rule, index) => {
    const label = rule.name || `Rule ${index + 1}`
    if (!rule.name.trim()) error(`Rule ${index + 1} has no name`)
    if (names.has(rule.name)) error(`Duplicate rule name "${rule.name}"`)
    names.add(rule.name)
    if (rule.routerosChain !== undefined && !ROUTEROS_CHAINS.includes(rule.routerosChain)) error(`${label}: invalid RouterOS chain "${rule.routerosChain}"`)
    if ((!rule.routerosChain || rule.routerosChain === 'Auto') && !['Inbound', 'Outbound'].includes(rule.direction)) error(`${label}: invalid Direction for Auto chain`)
    if (!['ALLOW', 'DROP', 'REJECT'].includes(rule.action)) error(`${label}: invalid RouterOS action`)
    if (!['TCP', 'UDP', 'ICMP', 'ANY'].includes(rule.protocol)) error(`${label}: invalid RouterOS protocol`)
    if (rule.service !== CUSTOM && !SERVICES[rule.service]) error(`${label}: unknown service`)
    if (rule.service !== CUSTOM && SERVICES[rule.service] && (rule.protocol !== SERVICES[rule.service].protocol || rule.ports !== SERVICES[rule.service].ports))
      error(`${label}: service does not match its protocol/ports; reselect the service or use Custom`)
    for (const [field, value] of [['source', rule.source], ['destination', rule.destination]] as const) {
      const parts = addresses(value)
      if (value.trim() === 'Internet') error(`${label}: Internet is ambiguous on RouterOS; specify explicit IPv4 hosts/prefixes`)
      else if (!(parts.length === 1 && parts[0] === '*') && parts.some((part) => !validAddress(part)))
        error(`${label}: invalid ${field} "${value}" — use Any, supported presets, or comma-separated literal IPv4 hosts/CIDRs (prefix 0–32); names, IPv6 and empty list entries are unsupported`)
    }
    if (rule.ports.trim()) {
      if (rule.protocol !== 'TCP' && rule.protocol !== 'UDP') error(`${label}: RouterOS ports require TCP or UDP; ports cannot be ignored for ${rule.protocol}`)
      for (const part of rule.ports.split(',')) {
        const port = part.trim()
        const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(port)
        if (!match || Number(match[1]) > 65535 || (match[2] !== undefined && (Number(match[2]) > 65535 || Number(match[1]) > Number(match[2]))))
          error(`${label}: invalid port/range "${port}" — use 0–65535 with ascending ranges`)
      }
    }
    const unsupported: string[] = (['program', 'scope', 'zone', 'srcZone', 'dstZone'] as const).filter((key) => rule[key].trim())
    if (rule.profile !== 'Any') unsupported.push('profile')
    if (unsupported.length) error(`${label}: RouterOS cannot represent ${unsupported.join(', ')}; clear these inherited fields before generating (use another target's editor or JSON)`)
    if (!rule.permanent) error(`${label}: RouterOS filter rules persist; runtime-only rules are unsupported — enable Permanent using the firewalld editor or JSON`)
    if (rule.priority.trim()) warn(`${label}: Priority is not applied; RouterOS priority matches packet priority, not rule order. The table order is used.`)
    if (catchAll(rule) && rule.action === 'ALLOW') warn(`${label}: allow any → any, all protocols/ports in ${routerosChain(rule)}`)
    if (catchAll(rule) && enabled.slice(index + 1).some((later) => routerosChain(later) === routerosChain(rule)))
      warn(`"${label}" is a catch-all ${rule.action.toLowerCase()} in ${routerosChain(rule)} — later rules in that chain never match`)
  })
  warn('RouterOS 7.x IPv4 filters only. Auto maps Inbound → input (to router), Outbound → output (from router); use forward for traffic through the router. Explicit Chain overrides Direction.')
  warn(format === 'terraform'
    ? 'Terraform owns generated rules in state: apply/destroy can update/delete them, including rules removed or disabled in the table. Native ordering moves only generated rule IDs; placement relative to unmanaged rules is not guaranteed. Changes are not atomic. Preserve state, review the plan and management access. Policy / ACL name is descriptive only.'
    : 'Append-only: no existing rules are removed or reordered. Reimport creates duplicates; earlier router rules may shadow the generated rules. Policy / ACL name is descriptive only.')
  warn('RouterOS accepts packets when no filter matches. No default deny, established/related accepts or return-traffic rules are added. Existing established/related accepts and FastTrack may bypass later denies; bridge and hardware-offloaded traffic may bypass IP filters. Review packet flow and management access before importing.')
  return issues
}

// RouterOS interpolates $ inside strings; physical newlines and control bytes must not escape into commands or comments.
const escapeText = (value: string): string => Array.from(value, (character) => {
  if (character === '"' || character === '\\' || character === '$') return `\\${character}`
  if (character === '\n') return '\\n'
  if (character === '\r') return '\\r'
  if (character === '\t') return '\\t'
  const code = character.codePointAt(0)!
  if (code >= 32 && code < 127) return character
  return [...new TextEncoder().encode(character)].map((byte) => `\\${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('')
}).join('')
const quoted = (value: string): string => `"${escapeText(value)}"`
const normalizedPorts = (ports: string): string => ports.split(',').map((port) => port.trim().split('-').map(Number).join('-')).join(',')

export const mikrotik = (rules: Rule[], { policyName }: { policyName: string }): string => {
  const issues = routerosIssues(rules)
  const header = [
    '# Firewall Forge — MikroTik RouterOS 7.x IPv4 filter',
    `# Policy label: ${quoted(policyName)}`,
    ...issues.filter((issue) => issue.level === 'warn').map((issue) => `# WARNING: ${escapeText(issue.message)}`),
  ]
  const errors = issues.filter((issue) => issue.level === 'error')
  if (errors.length) return [...header, '# BLOCKED: fix all enabled-rule errors; no commands generated.', ...errors.map((issue) => `# ERROR: ${escapeText(issue.message)}`)].join('\n') + '\n'
  const commands = rules.filter((rule) => rule.enabled).flatMap((rule) => addresses(rule.source).flatMap((source) => addresses(rule.destination).map((destination) => {
    const parts = ['/ip firewall filter add', `chain=${routerosChain(rule)}`, `action=${{ ALLOW: 'accept', DROP: 'drop', REJECT: 'reject' }[rule.action]}`]
    if (rule.action === 'REJECT') parts.push('reject-with=icmp-admin-prohibited')
    if (source !== '*') parts.push(`src-address=${source}`)
    if (destination !== '*') parts.push(`dst-address=${destination}`)
    if (rule.protocol !== 'ANY') parts.push(`protocol=${rule.protocol.toLowerCase()}`)
    if (rule.ports.trim()) parts.push(`dst-port=${normalizedPorts(rule.ports)}`)
    parts.push(`log=${rule.logging ? 'yes' : 'no'}`)
    if (rule.logging) parts.push(`log-prefix=${quoted(rule.name)}`)
    parts.push(`comment=${quoted(rule.notes ? `${rule.name}: ${rule.notes}` : rule.name)}`)
    return parts.join(' ')
  })))
  return [...header, '', ...commands].join('\n') + '\n'
}

const hclString = (value: string): string => JSON.stringify(value).replace(/\$\{/g, () => '$${').replace(/%\{/g, '%%{')
// Encode names losslessly: IDs remain stable across table reordering and cannot collide after sanitizing.
const terraformName = (name: string): string => `rule_${name.split('').map((character) => character.charCodeAt(0).toString(16).padStart(4, '0')).join('')}`

export const mikrotikTerraform = (rules: Rule[], { policyName }: { policyName: string }): string => {
  const issues = routerosIssues(rules, 'terraform')
  const header = [
    '# Firewall Forge — MikroTik RouterOS 7.x IPv4 filter (Terraform)',
    `# Policy label: ${hclString(policyName)}`,
    ...issues.map((issue) => `# ${issue.level === 'error' ? 'ERROR' : 'WARNING'}: ${escapeText(issue.message)}`),
  ].join('\n') + '\n'
  if (issues.some((issue) => issue.level === 'error'))
    return `${header}# BLOCKED: fix all enabled-rule errors; do not apply this file.\n# An impossible Terraform version constraint prevents an empty configuration from deleting managed rules.\nterraform {\n  required_version = "< 0.0.0"\n}\n`

  const resources: string[] = []
  const sequence: string[] = []
  for (const rule of rules.filter((rule) => rule.enabled)) {
    addresses(rule.source).forEach((source, sourceIndex) => addresses(rule.destination).forEach((destination, destinationIndex) => {
      const name = `${terraformName(rule.name)}_${sourceIndex}_${destinationIndex}`
      const fields: Record<string, string> = {
        chain: hclString(routerosChain(rule)),
        action: hclString({ ALLOW: 'accept', DROP: 'drop', REJECT: 'reject' }[rule.action]),
      }
      if (rule.action === 'REJECT') fields.reject_with = hclString('icmp-admin-prohibited')
      if (source !== '*') fields.src_address = hclString(source)
      if (destination !== '*') fields.dst_address = hclString(destination)
      if (rule.protocol !== 'ANY') fields.protocol = hclString(rule.protocol.toLowerCase())
      if (rule.ports.trim()) fields.dst_port = hclString(normalizedPorts(rule.ports))
      fields.disabled = 'false'
      fields.log = String(rule.logging)
      if (rule.logging) fields.log_prefix = hclString(rule.name)
      fields.comment = hclString(rule.notes ? `${rule.name}: ${rule.notes}` : rule.name)
      if (sequence.length) fields.depends_on = `[${sequence[sequence.length - 1]}]`
      const width = Math.max(...Object.keys(fields).map((field) => field.length))
      resources.push(`resource "routeros_ip_firewall_filter" "${name}" {\n${Object.entries(fields).map(([field, value]) => `  ${field.padEnd(width)} = ${value}`).join('\n')}\n}\n`)
      sequence.push(`routeros_ip_firewall_filter.${name}`)
    }))
  }
  const ordering = sequence.length > 1
    ? `resource "routeros_move_items" "generated_order" {\n  resource_path = "/ip/firewall/filter"\n  sequence = [\n${sequence.map((reference) => `    ${reference}.id,`).join('\n')}\n  ]\n}\n`
    : ''
  return `${header}\n${requiredProviders('routeros')}
# Configure credentials outside the browser; do not commit passwords or state.
variable "routeros_hosturl" {
  type        = string
  description = "HTTPS URL of the RouterOS REST endpoint"
  validation {
    condition     = can(regex("^https://", var.routeros_hosturl))
    error_message = "Use an HTTPS RouterOS endpoint with a trusted certificate."
  }
}

variable "routeros_username" {
  type = string
}

variable "routeros_password" {
  type      = string
  sensitive = true
}

provider "routeros" {
  hosturl  = var.routeros_hosturl
  username = var.routeros_username
  password = var.routeros_password
  insecure = false
}

${resources.join('\n')}${ordering ? `\n${ordering}` : ''}`
}
