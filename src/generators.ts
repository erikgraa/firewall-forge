import { ENDPOINTS, SERVICES } from './model'
import type { Rule, TargetId } from './model'

export interface Target {
  id: TargetId
  label: string
  hint: string
  filename: string
  generate: (rules: Rule[], opts: Options) => string
}

export interface Options {
  policyName: string
}

const prefixes = (value: string, key: 'nsx' | 'net'): string[] => {
  const v = value.trim()
  if (!v) return key === 'net' ? ['*'] : []
  const known = ENDPOINTS[v]
  if (known) return known[key]
  return v.split(/\s*,\s*/).filter(Boolean)
}

const q = (items: string[]) => items.map((i) => `"${i}"`).join(', ')
const active = (rules: Rule[]) => rules.filter((r) => r.enabled)
const prio = (r: Rule, i: number) => Number(r.priority) || 100 + (i + 1) * 10
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rules'

const nsx = (rules: Rule[], { policyName }: Options) => {
  const body = active(rules).map((r, i) => {
    const lines = [
      `    display_name       = "${r.name}"`,
      `    action             = "${r.action}"`,
      `    direction          = "${r.direction === 'Inbound' ? 'IN' : 'OUT'}"`,
    ]
    const src = prefixes(r.source, 'nsx')
    const dst = prefixes(r.destination, 'nsx')
    if (src.length) lines.push(`    source_groups      = [${q(src)}]`)
    if (dst.length) lines.push(`    destination_groups = [${q(dst)}]`)
    if (r.scope.trim()) lines.push(`    scope              = [${q(r.scope.split(/\s*,\s*/))}]`)
    if (r.logging) lines.push('    logged             = true')
    if (r.notes.trim()) lines.push(`    notes              = "${r.notes.trim()}"`)
    const svc = SERVICES[r.service]
    if (svc?.nsx) lines.push(`    services           = ["/infra/services/${svc.nsx}"]`)
    else if (r.service !== 'Custom' || r.ports)
      lines.push(`    # TODO: add an nsxt_policy_service for ${r.protocol} ${r.ports} and reference it in services`)
    lines.push(`    sequence_number    = ${(i + 1) * 10}`)
    return `\n  rule {\n${lines.join('\n')}\n  }`
  })
  return `resource "nsxt_policy_security_policy" "${slug(policyName)}" {
  display_name = "${policyName}"
  category     = "Application"
${body.join('\n')}
}
`
}

const aclAction = (r: Rule) => (r.action === 'ALLOW' ? 'Allow' : 'Deny')
const ncProtocol = (r: Rule) => ({ TCP: 'TCP', UDP: 'UDP', ICMP: 'ICMP', ANY: 'All' })[r.protocol]
const portRange = (r: Rule) => (r.ports.trim() ? r.ports.trim() : '0-65535')

const sdnPs = (rules: Rule[], { policyName }: Options) => {
  const rs = active(rules).map((r, i) => `
$props = New-Object Microsoft.Windows.NetworkController.AclRuleProperties
$props.Protocol                = "${ncProtocol(r)}"
$props.SourcePortRange         = "0-65535"
$props.DestinationPortRange    = "${portRange(r)}"
$props.SourceAddressPrefix     = "${prefixes(r.source, 'net').join(',')}"
$props.DestinationAddressPrefix = "${prefixes(r.destination, 'net').join(',')}"
$props.Action                  = "${aclAction(r)}"
$props.Type                    = "${r.direction}"
$props.Priority                = ${prio(r, i)}
$props.Logging                 = "${r.logging ? 'Enabled' : 'Disabled'}"
$rule = New-Object Microsoft.Windows.NetworkController.AclRule
$rule.ResourceId = "${r.name}"
$rule.Properties = $props
$aclProps.AclRules += $rule`)
  return `$uri = "https://<network-controller-fqdn>"

$aclProps = New-Object Microsoft.Windows.NetworkController.AccessControlListProperties
$aclProps.AclRules = @()
${rs.join('\n')}

New-NetworkControllerAccessControlList -ResourceId "${slug(policyName)}" -Properties $aclProps -ConnectionUri $uri
`
}

const azl = (rules: Rule[], { policyName }: Options) => {
  const quote = (a: string[]) => a.map((x) => `'${x}'`).join(' ')
  const lines = [
    '$rg  = "<resource-group>"',
    `$nsg = "${slug(policyName)}"`,
    '',
    'az stack-hci-vm network nsg create --resource-group $rg --name $nsg --location "<region>" --custom-location "<custom-location-id>"',
    '',
  ]
  active(rules).forEach((r, i) => {
    const proto = { TCP: 'Tcp', UDP: 'Udp', ICMP: 'Icmp', ANY: '*' }[r.protocol]
    lines.push(
      `az stack-hci-vm network nsg rule create --resource-group $rg --nsg-name $nsg --name '${r.name}' ` +
        `--priority ${prio(r, i)} --access ${aclAction(r)} --direction ${r.direction} --protocol ${proto} ` +
        `--source-address-prefixes ${quote(prefixes(r.source, 'net'))} --source-port-ranges '*' ` +
        `--destination-address-prefixes ${quote(prefixes(r.destination, 'net'))} ` +
        `--destination-port-ranges '${r.ports.trim() || '*'}'`,
    )
  })
  return lines.join('\n') + '\n'
}

const isIp = (s: string) => /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(s)
const splitPorts = (r: Rule): string[] => (r.ports.trim() && r.protocol !== 'ICMP' && r.protocol !== 'ANY' ? r.ports.split(',').map((p) => p.trim()) : [])

const windows = (rules: Rule[], { policyName }: Options) => {
  const arr = (a: string[]) => a.map((x) => `'${x}'`).join(',')
  const lines = [
    '# Windows Defender Firewall evaluates Block rules before Allow rules, regardless of order.',
    '',
  ]
  active(rules).forEach((r) => {
    const proto = { TCP: 'TCP', UDP: 'UDP', ICMP: 'ICMPv4', ANY: 'Any' }[r.protocol]
    const inbound = r.direction === 'Inbound'
    const src = prefixes(r.source, 'net').map((x) => (x === '*' ? 'Any' : x))
    const dst = prefixes(r.destination, 'net').map((x) => (x === '*' ? 'Any' : x))
    const ports = splitPorts(r)
    const parts = [
      `New-NetFirewallRule -DisplayName '${r.name}' -Group '${policyName}' -Direction ${r.direction}`,
      `-Action ${r.action === 'ALLOW' ? 'Allow' : 'Block'} -Protocol ${proto} -Profile ${r.profile} -Enabled True`,
      `-${inbound ? 'RemoteAddress' : 'LocalAddress'} ${arr(src)}`,
      `-${inbound ? 'LocalAddress' : 'RemoteAddress'} ${arr(dst)}`,
    ]
    if (ports.length) parts.push(`-${inbound ? 'LocalPort' : 'RemotePort'} ${arr(ports)}`)
    if (r.program.trim()) parts.push(`-Program '${r.program.trim()}'`)
    lines.push(parts.join(' '))
  })
  return lines.join('\n') + '\n'
}

const firewalld = (rules: Rule[], { policyName }: Options) => {
  const act = (r: Rule) => ({ ALLOW: 'accept', DROP: 'drop', REJECT: 'reject' })[r.action]
  const live = active(rules)
  const hasOut = live.some((r) => r.direction === 'Outbound')
  const setup: string[] = []
  if (hasOut) {
    setup.push(
      '# firewalld zones only filter inbound traffic; outbound rules use a policy (HOST -> ANY)',
      `firewall-cmd --permanent --new-policy ${slug(policyName)}-out`,
      `firewall-cmd --permanent --policy ${slug(policyName)}-out --add-ingress-zone HOST`,
      `firewall-cmd --permanent --policy ${slug(policyName)}-out --add-egress-zone ANY`,
    )
  }

  const emit = (r: Rule, i: number): string[] => {
    const src = prefixes(r.source, 'nsx')
    const dst = prefixes(r.destination, 'nsx')
    const bad = [...src, ...dst].find((x) => !isIp(x))
    const lines = [`# ${r.name}${r.permanent ? '' : ' (runtime only)'}`]
    if (bad) {
      lines.push(`# TODO: "${bad}" is not an IP/CIDR — use an ipset (source ipset="...") instead`)
      return lines
    }
    const proto = { TCP: 'tcp', UDP: 'udp', ICMP: 'icmp', ANY: '' }[r.protocol]
    const ports = splitPorts(r)
    const target = r.direction === 'Inbound' ? `--zone=${r.zone.trim() || 'public'}` : `--policy ${slug(policyName)}-out`
    for (const s of src.length ? src : [undefined]) {
      for (const d of dst.length ? dst : [undefined]) {
        for (const p of ports.length ? ports : [undefined]) {
          const rule = [`rule priority="${(i + 1) * 10}"`]
          if (s || d) rule.push('family="ipv4"')
          if (s) rule.push(`source address="${s}"`)
          if (d) rule.push(`destination address="${d}"`)
          if (p) rule.push(`port port="${p}" protocol="${proto}"`)
          else if (proto) rule.push(`protocol value="${proto}"`)
          if (r.logging) rule.push(`log prefix="${r.name}: " level="info"`)
          rule.push(act(r))
          lines.push(`firewall-cmd${r.permanent ? ' --permanent' : ''} ${target} --add-rich-rule='${rule.join(' ')}'`)
        }
      }
    }
    return lines
  }

  // A reload drops runtime-only rules, so permanent rules go first, then the reload, then runtime rules.
  const perm = live.map((r, i) => ({ r, i })).filter((x) => x.r.permanent)
  const runtime = live.map((r, i) => ({ r, i })).filter((x) => !x.r.permanent)
  const lines: string[] = [...setup]
  if (setup.length) lines.push('')
  for (const { r, i } of perm) lines.push(...emit(r, i))
  if (perm.length || setup.length) lines.push('', 'firewall-cmd --reload')
  if (runtime.length) {
    lines.push('', '# Runtime-only rules: lost on reload or reboot. Persist them with firewall-cmd --runtime-to-permanent', '')
    for (const { r, i } of runtime) lines.push(...emit(r, i))
  }
  return lines.join('\n') + '\n'
}

const wildcard = (cidr: string): string => {
  const [ip, bits = '32'] = cidr.split('/')
  if (bits === '32') return `host ${ip}`
  const n = Number(bits)
  const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0
  const wc = (~mask >>> 0) >>> 0
  const net = ip.split('.').map(Number).reduce((a, o) => ((a << 8) | o) >>> 0, 0) & mask
  const dotted = (v: number) => [24, 16, 8, 0].map((s) => (v >>> s) & 255).join('.')
  return `${dotted(net >>> 0)} ${dotted(wc)}`
}

const cisco = (rules: Rule[], { policyName }: Options) => {
  const out: string[] = []
  const base = slug(policyName)
  for (const dir of ['Inbound', 'Outbound'] as const) {
    const subset = active(rules).filter((r) => r.direction === dir)
    if (!subset.length) continue
    const name = `${base}-${dir === 'Inbound' ? 'in' : 'out'}`
    out.push(`ip access-list extended ${name}`)
    let seq = 0
    for (const r of subset) {
      out.push(` remark ${r.name}`)
      const src = prefixes(r.source, 'nsx')
      const dst = prefixes(r.destination, 'nsx')
      const bad = [...src, ...dst].find((x) => !isIp(x))
      if (bad) {
        out.push(` ! TODO: "${bad}" is not an IP/CIDR — use an object-group`)
        continue
      }
      const proto = { TCP: 'tcp', UDP: 'udp', ICMP: 'icmp', ANY: 'ip' }[r.protocol]
      const ports = splitPorts(r)
      const single = ports.filter((p) => !p.includes('-'))
      const ranges = ports.filter((p) => p.includes('-'))
      const portSpecs = ports.length
        ? [...(single.length ? [`eq ${single.join(' ')}`] : []), ...ranges.map((p) => `range ${p.replace('-', ' ')}`)]
        : ['']
      for (const s of src.length ? src : ['any']) {
        for (const d of dst.length ? dst : ['any']) {
          for (const ps of portSpecs) {
            seq += 10
            const fmt = (x: string) => (x === 'any' ? 'any' : wildcard(x))
            out.push(` ${seq} ${r.action === 'ALLOW' ? 'permit' : 'deny'} ${proto} ${fmt(s)} ${fmt(d)}${ps ? ` ${ps}` : ''}${r.logging ? ' log' : ''}`)
          }
        }
      }
    }
    out.push('!', `! apply with: interface <if> / ip access-group ${name} ${dir === 'Inbound' ? 'in' : 'out'}`, '! (implicit "deny ip any any" at the end of every ACL)', '!')
  }
  return out.join('\n') + '\n'
}

const panos = (rules: Rule[], { policyName }: Options) => {
  const list = (a: string[]) => `[${a.map((x) => `"${x}"`).join(', ')}]`
  const addr = (v: string) => {
    const p = prefixes(v, 'nsx')
    return p.length ? p : ['any']
  }
  const zones = (v: string) => (v.trim() ? v.split(/\s*,\s*/) : ['any'])
  const svcs = new Map<string, { proto: string; port: string }>()
  const svcRefs = (r: Rule): string[] => {
    if (r.protocol === 'ICMP') return ['any'] // ICMP is matched through applications
    const ports = splitPorts(r)
    if (!ports.length) return ['any']
    return ports.map((p) => {
      const proto = r.protocol === 'ANY' ? 'tcp' : r.protocol.toLowerCase()
      const name = `${proto}-${p}`
      svcs.set(name, { proto, port: p })
      return name
    })
  }
  const apps = (r: Rule) => (r.protocol === 'ICMP' ? ['icmp', 'ping'] : ['any'])
  const location = '  location = {\n    vsys = {\n      name = "vsys1"\n    }\n  }\n'

  const body = active(rules).map((r) => {
    const act = { ALLOW: 'allow', DROP: 'drop', REJECT: 'reset-both' }[r.action]
    const bad = [...addr(r.source), ...addr(r.destination)].filter((x) => x !== 'any' && !isIp(x))
    const lines = [
      ...(bad.length ? [`      # TODO: ${bad.map((b) => `"${b}"`).join(', ')} must exist as a panos_address / panos_address_group`] : []),
      `      name                  = "${r.name}"`,
      `      source_zones          = ${list(zones(r.srcZone))}`,
      `      source_addresses      = ${list(addr(r.source))}`,
      `      destination_zones     = ${list(zones(r.dstZone))}`,
      `      destination_addresses = ${list(addr(r.destination))}`,
      `      applications          = ${list(apps(r))}`,
      `      services              = [${svcRefs(r).map((n) => (svcs.has(n) ? `panos_service.${n}.name` : `"${n}"`)).join(', ')}]`,
      `      action                = "${act}"`,
      `      log_end               = ${r.logging}`,
    ]
    if (r.notes.trim()) lines.push(`      description           = "${r.notes.trim()}"`)
    return `    {\n${lines.join('\n')}\n    },`
  })

  const objs = [...svcs.entries()].map(
    ([name, s]) => `resource "panos_service" "${name}" {
${location}
  name = "${name}"

  protocol = {
    ${s.proto} = {
      destination_port = "${s.port}"
    }
  }
}
`,
  )
  return `terraform {
  required_providers {
    panos = {
      source  = "PaloAltoNetworks/panos"
      version = "~> 2.0"
    }
  }
}

${objs.join('\n')}${objs.length ? '\n' : ''}# Manages the entire rulebase at this location; rules outside this list are removed.
resource "panos_security_policy" "${slug(policyName).replace(/-/g, '_')}" {
${location}
  rules = [
${body.join('\n')}
  ]
}
`
}

const nftSet = (items: string[]) => (items.length === 1 ? items[0] : `{ ${items.join(', ')} }`)

const nftables = (rules: Rule[], { policyName }: Options) => {
  const table = slug(policyName).replace(/-/g, '_')
  const chains: Record<'Inbound' | 'Outbound', string[]> = { Inbound: [], Outbound: [] }

  for (const r of active(rules)) {
    const src = prefixes(r.source, 'nsx')
    const dst = prefixes(r.destination, 'nsx')
    const bad = [...src, ...dst].find((x) => !isIp(x))
    const out = chains[r.direction]
    if (bad) {
      out.push(`    # ${r.name}: TODO "${bad}" is not an IP/CIDR — define a named set and use @set instead`)
      continue
    }
    const ports = splitPorts(r)
    const parts: string[] = []
    if (src.length) parts.push(`ip saddr ${nftSet(src)}`)
    if (dst.length) parts.push(`ip daddr ${nftSet(dst)}`)
    if (r.protocol === 'ICMP') parts.push('ip protocol icmp')
    else if (r.protocol !== 'ANY') parts.push(ports.length ? `${r.protocol.toLowerCase()} dport ${nftSet(ports)}` : `meta l4proto ${r.protocol.toLowerCase()}`)
    if (r.logging) parts.push(`log prefix "${r.name}: "`)
    parts.push({ ALLOW: 'accept', DROP: 'drop', REJECT: 'reject' }[r.action])
    parts.push(`comment "${r.name}"`)
    out.push(`    ${parts.join(' ')}`)
  }

  const chain = (name: string, hook: string, body: string[]) =>
    `  chain ${name} {\n    type filter hook ${hook} priority filter; policy accept;\n${body.join('\n')}${body.length ? '\n' : ''}  }`

  return `#!/usr/sbin/nft -f
# Chains default to "policy accept"; end with an explicit drop rule for a default-deny stance.

table inet ${table} {
${chain('input', 'input', chains.Inbound)}

${chain('output', 'output', chains.Outbound)}
}
`
}

const iptables = (rules: Rule[]) => {
  const lines: string[] = []
  for (const r of active(rules)) {
    const src = prefixes(r.source, 'nsx')
    const dst = prefixes(r.destination, 'nsx')
    const bad = [...src, ...dst].find((x) => !isIp(x))
    lines.push(`# ${r.name}`)
    if (bad) {
      lines.push(`# TODO: "${bad}" is not an IP/CIDR — create an ipset and use -m set --match-set`)
      continue
    }
    const chain = r.direction === 'Inbound' ? 'INPUT' : 'OUTPUT'
    const ports = splitPorts(r).map((p) => p.replace('-', ':'))
    const base = [`iptables -A ${chain}`]
    if (src.length) base.push(`-s ${src.join(',')}`)
    if (dst.length) base.push(`-d ${dst.join(',')}`)
    if (r.protocol !== 'ANY') base.push(`-p ${r.protocol.toLowerCase()}`)
    if (ports.length === 1) base.push(`--dport ${ports[0]}`)
    else if (ports.length > 1) base.push(`-m multiport --dports ${ports.join(',')}`)
    const comment = `-m comment --comment "${r.name}"`
    const target = { ALLOW: 'ACCEPT', DROP: 'DROP', REJECT: 'REJECT' }[r.action]
    if (r.logging) lines.push([...base, comment, `-j LOG --log-prefix "${r.name}: "`].join(' '))
    lines.push([...base, comment, `-j ${target}`].join(' '))
  }
  lines.push('', '# IPv4 only. Persist with iptables-save (e.g. via iptables-persistent / netfilter-persistent).')
  return lines.join('\n') + '\n'
}

const fmc = (rules: Rule[], { policyName }: Options) => {
  const q = (x: string) => `"${x}"`
  const ident = (s: string) => s.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^(\d)/, '_$1')
  const zoneData = new Map<string, string>()
  const netData = new Map<string, string>()

  const zoneBlock = (field: string, value: string): string[] => {
    const names = value.trim() ? value.split(/\s*,\s*/) : []
    if (!names.length) return []
    const refs = names.map((n) => {
      const key = ident(n)
      zoneData.set(key, n)
      return `        { id = data.fmc_security_zone.${key}.id }`
    })
    return [`      ${field} = [`, refs.join(',\n'), '      ]']
  }

  const netBlock = (prefix: 'source' | 'destination', value: string): string[] => {
    const items = prefixes(value, 'nsx')
    const literals = items.filter(isIp)
    const named = items.filter((x) => !isIp(x))
    const out: string[] = []
    if (literals.length)
      out.push(`      ${prefix}_network_literals = [`, literals.map((v) => `        { value = ${q(v)} }`).join(',\n'), '      ]')
    if (named.length) {
      const refs = named.map((n) => {
        const key = ident(n)
        netData.set(key, n)
        return `        { id = data.fmc_network.${key}.id, type = "Network" }`
      })
      out.push(`      ${prefix}_network_objects = [`, refs.join(',\n'), '      ]')
    }
    return out
  }

  const portBlock = (r: Rule): string[] => {
    if (r.protocol === 'ICMP') return ['      destination_port_literals = [', '        { type = "ICMPv4PortLiteral", protocol = "1" }', '      ]']
    if (r.protocol === 'ANY') return []
    const proto = r.protocol === 'TCP' ? '6' : '17'
    const ports = splitPorts(r)
    if (!ports.length) return ['      destination_port_literals = [', `        { type = "PortLiteral", protocol = "${proto}" }`, '      ]']
    return ['      destination_port_literals = [', ports.map((p) => `        { type = "PortLiteral", protocol = "${proto}", port = ${q(p)} }`).join(',\n'), '      ]']
  }

  const body = active(rules).map((r) => {
    const action = { ALLOW: 'ALLOW', DROP: 'BLOCK', REJECT: 'BLOCK_RESET' }[r.action]
    const lines = [
      `      name = ${q(r.name)}`,
      `      action = ${q(action)}`,
      ...zoneBlock('source_zones', r.srcZone),
      ...zoneBlock('destination_zones', r.dstZone),
      ...netBlock('source', r.source),
      ...netBlock('destination', r.destination),
      ...portBlock(r),
    ]
    if (r.logging) lines.push('      log_connection_end = true', '      send_events_to_fmc = true')
    if (r.notes.trim()) lines.push(`      description = ${q(r.notes.trim())}`)
    return `    {\n${lines.join('\n')}\n    }`
  })

  const data = [
    ...[...zoneData.entries()].map(([k, n]) => `data "fmc_security_zone" "${k}" {\n  name = ${q(n)}\n}\n`),
    ...[...netData.entries()].map(([k, n]) => `# Assumes an existing Network object; use fmc_host / fmc_network_group data sources for other types.\ndata "fmc_network" "${k}" {\n  name = ${q(n)}\n}\n`),
  ]

  return `terraform {
  required_providers {
    fmc = {
      source  = "CiscoDevNet/fmc"
      version = "~> 2.0"
    }
  }
}

# Credentials: set FMC_USERNAME and FMC_PASSWORD in the environment.
provider "fmc" {
  url = "https://<fmc-host>"
}

${data.join('\n')}${data.length ? '\n' : ''}resource "fmc_access_control_policy" "${ident(slug(policyName))}" {
  name           = ${q(policyName)}
  default_action = "BLOCK"

  # With manage_rules = true this resource owns the whole rule list; rules not listed here are removed.
  manage_rules = true
  rules = [
${body.join(',\n')}
  ]
}
`
}

const azlBicep = (rules: Rule[], { policyName }: Options) => {
  const ident = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^(\d)/, '_$1')
  const strs = (a: string[]) => `[${a.map((x) => `'${x}'`).join(', ')}]`
  const proto = { TCP: 'Tcp', UDP: 'Udp', ICMP: 'Icmp', ANY: '*' }
  const nsg = ident(slug(policyName))

  const body = active(rules).map((r, i) => {
    const ports = splitPorts(r)
    const lines = [
      `  parent: ${nsg}`,
      `  name: '${r.name}'`,
      '  extendedLocation: {',
      '    name: customLocationId',
      "    type: 'CustomLocation'",
      '  }',
      '  properties: {',
      `    priority: ${prio(r, i)}`,
      `    access: '${aclAction(r)}'`,
      `    direction: '${r.direction}'`,
      `    protocol: '${proto[r.protocol]}'`,
      `    sourceAddressPrefixes: ${strs(prefixes(r.source, 'net'))}`,
      "    sourcePortRanges: ['*']",
      `    destinationAddressPrefixes: ${strs(prefixes(r.destination, 'net'))}`,
      `    destinationPortRanges: ${strs(ports.length ? ports : ['*'])}`,
    ]
    if (r.notes.trim()) lines.push(`    description: '${r.notes.trim().slice(0, 140)}'`)
    lines.push('  }')
    return `resource ${ident(r.name) || `rule${i}`}Rule 'Microsoft.AzureStackHCI/networkSecurityGroups/securityRules@2025-09-01-preview' = {\n${lines.join('\n')}\n}\n`
  })

  return `param location string
param customLocationId string

resource ${nsg} 'Microsoft.AzureStackHCI/networkSecurityGroups@2025-09-01-preview' = {
  name: '${slug(policyName)}'
  location: location
  extendedLocation: {
    name: customLocationId
    type: 'CustomLocation'
  }
  properties: {}
}

${body.join('\n')}`
}

export const TARGETS: Target[] = [
  { id: 'nsx', label: 'NSX DFW', hint: 'Terraform (vmware/nsxt)', filename: 'main.tf', generate: nsx },
  { id: 'sdn-ps', label: 'SDN ACL', hint: 'PowerShell', filename: 'sdn-acl.ps1', generate: sdnPs },
  { id: 'azl-nsg', label: 'Azure Local NSG', hint: 'az CLI', filename: 'azl-nsg.ps1', generate: azl },
  { id: 'azl-bicep', label: 'Azure Local NSG', hint: 'Bicep', filename: 'azl-nsg.bicep', generate: azlBicep },
  { id: 'windows', label: 'Windows Firewall', hint: 'PowerShell', filename: 'windows-firewall.ps1', generate: windows },
  { id: 'nftables', label: 'nftables', hint: 'Linux', filename: 'rules.nft', generate: nftables },
  { id: 'iptables', label: 'iptables', hint: 'Linux (legacy)', filename: 'iptables.sh', generate: iptables },
  { id: 'firewalld', label: 'firewalld', hint: 'RHEL / Fedora', filename: 'firewalld.sh', generate: firewalld },
  { id: 'cisco', label: 'Cisco ACL', hint: 'IOS extended', filename: 'acl.ios', generate: cisco },
  { id: 'fmc', label: 'Cisco FMC', hint: 'Terraform (fmc 2.x)', filename: 'fmc.tf', generate: fmc },
  { id: 'panos', label: 'Palo Alto', hint: 'Terraform (panos 2.x)', filename: 'panos.tf', generate: panos },
]
