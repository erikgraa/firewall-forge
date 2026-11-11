import { ENDPOINTS } from './model'
import type { Rule } from './model'
import type { Issue } from './validate'

export const azureIpv4 = (value: string): boolean => {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/.exec(value)
  return !!match && match[1].split('.').every((part) => Number(part) <= 255) && (match[2] === undefined || Number(match[2]) <= 32)
}

export const azureFqdn = (value: string): boolean => value.length <= 253 && value.includes('.') && value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) && !/^\d+$/.test(value.split('.').at(-1)!)

export const azureScriptIssues = (rules: Rule[]): Issue[] => {
  const issues: Issue[] = []
  const enabled = rules.filter((rule) => rule.enabled)
  let collections = 0
  let previous: Rule['action'] | undefined
  for (const rule of enabled) {
    const error = (message: string) => issues.push({ level: 'error', message: `${rule.name || 'Unnamed rule'}: ${message}` })
    if (rule.action !== previous) collections++
    previous = rule.action
    if (rule.action === 'REJECT') error('Azure Firewall cannot represent REJECT; choose DROP explicitly for Deny.')
    if (rule.priority.trim()) error('per-rule priority is unsupported; use list order and review group/collection priorities in the script.')
    if (rule.logging) error('per-rule logging is unsupported; configure Azure Firewall diagnostic settings separately.')
    if (rule.scope.trim() || rule.program.trim() || rule.profile !== 'Any' || rule.zone.trim() || rule.srcZone.trim() || rule.dstZone.trim() || !rule.permanent || (rule.routerosChain && rule.routerosChain !== 'Auto'))
      error('target-specific scope, program, profile, zone, chain or runtime-only options cannot be mapped to a Firewall Policy network rule.')
    if (rule.notes.length > 500) error('description exceeds 500 characters; shorten Notes instead of truncating them.')
    if (!/^[a-z0-9](?:[a-z0-9_.-]{0,78}[a-z0-9_])?$/i.test(rule.name)) error('Azure rule names must be 1–80 letters, digits, underscores, periods or hyphens, starting with a letter/digit and ending with a letter/digit/underscore.')
    if (rule.protocol === 'ICMP' && rule.ports.trim()) error('ICMP has no destination-port mapping; clear Ports.')
    if (rule.protocol === 'ANY' && rule.ports.trim()) error('ANY with restricted ports cannot preserve all-protocol intent; choose TCP/UDP or clear Ports.')
    if (rule.ports.trim().split(',').some((port) => {
      if (!port.trim()) return !!rule.ports.trim()
      const numbers = port.trim().split('-').map(Number)
      return numbers.some((number) => !Number.isInteger(number) || number < 1 || number > 65535) || numbers.length > 2 || (numbers.length === 2 && numbers[0] > numbers[1])
    })) error('ports must be 1–65535 or ascending ranges; use blank for all ports.')
    for (const field of ['source', 'destination'] as const) {
      const value = rule[field].trim()
      const addresses = ENDPOINTS[value]?.nsx ?? (value ? value.split(',').map((address) => address.trim()) : [])
      if (field === 'destination' && addresses.some((address) => azureFqdn(address)) && addresses.some((address) => address === '*' || azureIpv4(address)))
        error('IP addresses and FQDNs cannot be combined in one network rule; use separate same-action rules.')
      for (const address of addresses) {
        if (address === '*' || azureIpv4(address)) continue
        if (field === 'destination' && azureFqdn(address)) {
          if (rule.protocol !== 'TCP' && rule.protocol !== 'UDP') error('destination FQDNs require TCP or UDP network rules.')
          continue
        }
        error(`unsupported ${field} address "${address}"; use IPv4/CIDR, Any/*, or an exact destination FQDN. IPv6, wildcard FQDNs, named groups and service tags are not supported by these scripts.`)
      }
    }
  }
  if (collections > 641) issues.push({ level: 'error', message: 'Too many action runs: generated collection priorities would exceed Azure’s 65000 maximum.' })
  return issues
}

export const AZURE_SCRIPT_WARNING = 'These scripts create or replace ONE rule collection group in an existing Firewall Policy, removing all previous collections/rules in that group (including application/DNAT rules). Default mode is local review only; applying requires explicit consent. List order sets collection priorities from 1000 in steps of 100; group priority defaults to 1000. Direction is informational: matching is source → destination, with stateful return traffic. Parent policies and earlier groups may take precedence; DNAT is evaluated before network rules, then application rules. No firewall, routing, DNS proxy or diagnostic settings are created. Exact destination FQDNs require DNS proxy and match resolved IPs, not HTTP host/SNI.'
