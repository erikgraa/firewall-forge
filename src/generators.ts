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

const sdnJson = (rules: Rule[], { policyName }: Options) =>
  JSON.stringify(
    {
      resourceId: slug(policyName),
      properties: {
        aclRules: active(rules).map((r, i) => ({
          resourceId: r.name,
          properties: {
            protocol: ncProtocol(r),
            sourcePortRange: '0-65535',
            destinationPortRange: portRange(r),
            sourceAddressPrefix: prefixes(r.source, 'net').join(','),
            destinationAddressPrefix: prefixes(r.destination, 'net').join(','),
            action: aclAction(r),
            type: r.direction,
            priority: prio(r, i),
            logging: r.logging ? 'Enabled' : 'Disabled',
          },
        })),
      },
    },
    null,
    2,
  ) + '\n'

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
  const hasOut = active(rules).some((r) => r.direction === 'Outbound')
  const lines: string[] = []
  if (hasOut) {
    lines.push(
      '# firewalld zones only filter inbound traffic; outbound rules use a policy (HOST -> ANY)',
      `firewall-cmd --permanent --new-policy ${slug(policyName)}-out`,
      `firewall-cmd --permanent --policy ${slug(policyName)}-out --add-ingress-zone HOST`,
      `firewall-cmd --permanent --policy ${slug(policyName)}-out --add-egress-zone ANY`,
      '',
    )
  }
  active(rules).forEach((r, i) => {
    const src = prefixes(r.source, 'nsx')
    const dst = prefixes(r.destination, 'nsx')
    const bad = [...src, ...dst].find((x) => !isIp(x))
    lines.push(`# ${r.name}`)
    if (bad) {
      lines.push(`# TODO: "${bad}" is not an IP/CIDR — use an ipset (source ipset="...") instead`)
      return
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
          lines.push(`firewall-cmd --permanent ${target} --add-rich-rule='${rule.join(' ')}'`)
        }
      }
    }
  })
  lines.push('', 'firewall-cmd --reload')
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

export const TARGETS: Target[] = [
  { id: 'nsx', label: 'NSX DFW', hint: 'Terraform (vmware/nsxt)', filename: 'main.tf', generate: nsx },
  { id: 'sdn-ps', label: 'SDN ACL', hint: 'PowerShell', filename: 'sdn-acl.ps1', generate: sdnPs },
  { id: 'sdn-json', label: 'SDN ACL', hint: 'REST JSON', filename: 'sdn-acl.json', generate: sdnJson },
  { id: 'azl-nsg', label: 'Azure Local NSG', hint: 'az CLI', filename: 'azl-nsg.ps1', generate: azl },
  { id: 'windows', label: 'Windows Firewall', hint: 'PowerShell', filename: 'windows-firewall.ps1', generate: windows },
  { id: 'firewalld', label: 'firewalld', hint: 'RHEL / Fedora', filename: 'firewalld.sh', generate: firewalld },
  { id: 'cisco', label: 'Cisco ACL', hint: 'IOS extended', filename: 'acl.ios', generate: cisco },
]
