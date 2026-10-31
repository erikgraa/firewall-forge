import { ENDPOINTS, SERVICES } from './model'
import type { Rule, TargetId } from './model'

export interface Target {
  id: TargetId
  platform: string
  label: string
  format: string
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

interface FwRule {
  zone?: string
  policy?: string
  rich: string
}
interface FwItem {
  name: string
  runtimeOnly: boolean
  todo?: string
  rules: FwRule[]
}

const firewalldPlan = (rules: Rule[], policyName: string) => {
  const act = (r: Rule) => ({ ALLOW: 'accept', DROP: 'drop', REJECT: 'reject' })[r.action]
  const live = active(rules)
  const policy = live.some((r) => r.direction === 'Outbound') ? `${slug(policyName)}-out` : null

  const item = (r: Rule, i: number): FwItem => {
    const src = prefixes(r.source, 'nsx')
    const dst = prefixes(r.destination, 'nsx')
    const bad = [...src, ...dst].find((x) => !isIp(x))
    const out: FwItem = { name: r.name, runtimeOnly: !r.permanent, rules: [] }
    if (bad) {
      out.todo = `TODO: "${bad}" is not an IP/CIDR — use an ipset (source ipset="...") instead`
      return out
    }
    const proto = { TCP: 'tcp', UDP: 'udp', ICMP: 'icmp', ANY: '' }[r.protocol]
    const ports = splitPorts(r)
    const where = r.direction === 'Inbound' ? { zone: r.zone.trim() || 'public' } : { policy: policy! }
    for (const s of src.length ? src : [undefined]) {
      for (const d of dst.length ? dst : [undefined]) {
        for (const p of ports.length ? ports : [undefined]) {
          const rich = [`rule priority="${(i + 1) * 10}"`]
          if (s || d) rich.push('family="ipv4"')
          if (s) rich.push(`source address="${s}"`)
          if (d) rich.push(`destination address="${d}"`)
          if (p) rich.push(`port port="${p}" protocol="${proto}"`)
          else if (proto) rich.push(`protocol value="${proto}"`)
          if (r.logging) rich.push(`log prefix="${r.name}: " level="info"`)
          rich.push(act(r))
          out.rules.push({ ...where, rich: rich.join(' ') })
        }
      }
    }
    return out
  }

  const items = live.map((r, i) => ({ r, item: item(r, i) }))
  return {
    policy,
    perm: items.filter((x) => x.r.permanent).map((x) => x.item),
    runtime: items.filter((x) => !x.r.permanent).map((x) => x.item),
  }
}

const firewalld = (rules: Rule[], { policyName }: Options) => {
  const { policy, perm, runtime } = firewalldPlan(rules, policyName)
  const emit = (it: FwItem): string[] => {
    const lines = [`# ${it.name}${it.runtimeOnly ? ' (runtime only)' : ''}`]
    if (it.todo) return [...lines, `# ${it.todo}`]
    for (const r of it.rules) {
      const target = r.zone ? `--zone=${r.zone}` : `--policy ${r.policy}`
      lines.push(`firewall-cmd${it.runtimeOnly ? '' : ' --permanent'} ${target} --add-rich-rule='${r.rich}'`)
    }
    return lines
  }

  const lines: string[] = []
  if (policy) {
    lines.push(
      '# firewalld zones only filter inbound traffic; outbound rules use a policy (HOST -> ANY)',
      `firewall-cmd --permanent --new-policy ${policy}`,
      `firewall-cmd --permanent --policy ${policy} --add-ingress-zone HOST`,
      `firewall-cmd --permanent --policy ${policy} --add-egress-zone ANY`,
      '',
    )
  }
  // A reload drops runtime-only rules, so permanent rules go first, then the reload, then runtime rules.
  for (const it of perm) lines.push(...emit(it))
  if (perm.length || policy) lines.push('', 'firewall-cmd --reload')
  if (runtime.length) {
    lines.push('', '# Runtime-only rules: lost on reload or reboot. Persist them with firewall-cmd --runtime-to-permanent', '')
    for (const it of runtime) lines.push(...emit(it))
  }
  return lines.join('\n') + '\n'
}

const yq = (s: string) => `'${s.replace(/'/g, "''")}'`

const firewalldAnsible = (rules: Rule[], { policyName }: Options) => {
  const { policy, perm, runtime } = firewalldPlan(rules, policyName)
  const tasks: string[] = []
  const cmdTask = (name: string, argv: string[], tolerate?: string) =>
    [
      `    - name: ${yq(name)}`,
      '      ansible.builtin.command:',
      `        argv: [${argv.map(yq).join(', ')}]`,
      ...(tolerate
        ? ['      register: result', `      failed_when: result.rc != 0 and ${yq(tolerate)} not in result.stderr`, '      changed_when: result.rc == 0']
        : ['      changed_when: false']),
    ].join('\n')
  const emit = (it: FwItem) => {
    if (it.todo) {
      tasks.push(`    # ${it.name}: ${it.todo}`)
      return
    }
    it.rules.forEach((r, n) => {
      const label = `${it.name}${it.rules.length > 1 ? ` (${n + 1}/${it.rules.length})` : ''}`
      if (r.zone) {
        tasks.push(
          [
            `    - name: ${yq(label)}`,
            '      ansible.posix.firewalld:',
            `        zone: ${r.zone}`,
            `        rich_rule: ${yq(r.rich)}`,
            `        permanent: ${!it.runtimeOnly}`,
            '        immediate: true',
            '        state: enabled',
          ].join('\n'),
        )
      } else {
        // The firewalld module cannot target policies, so outbound rules call firewall-cmd directly.
        tasks.push(cmdTask(label, ['firewall-cmd', ...(it.runtimeOnly ? [] : ['--permanent']), '--policy', r.policy!, '--add-rich-rule', r.rich]))
      }
    })
  }

  if (policy) {
    tasks.push(cmdTask(`Create policy ${policy}`, ['firewall-cmd', '--permanent', '--new-policy', policy], 'NAME_CONFLICT'))
    tasks.push(cmdTask('Policy ingress zone HOST', ['firewall-cmd', '--permanent', '--policy', policy, '--add-ingress-zone', 'HOST']))
    tasks.push(cmdTask('Policy egress zone ANY', ['firewall-cmd', '--permanent', '--policy', policy, '--add-egress-zone', 'ANY']))
  }
  for (const it of perm) emit(it)
  if (perm.length || policy) tasks.push(cmdTask('Reload firewalld (drops runtime-only rules)', ['firewall-cmd', '--reload']))
  for (const it of runtime) emit(it)

  return `---
- name: ${yq(`${policyName} (firewalld)`)}
  hosts: all
  become: true
  # Requires: ansible-galaxy collection install ansible.posix
  tasks:
${tasks.join('\n\n')}
`
}

const iptablesAnsible = (rules: Rule[], { policyName }: Options) => {
  const tasks: string[] = []
  for (const r of active(rules)) {
    const src = prefixes(r.source, 'nsx')
    const dst = prefixes(r.destination, 'nsx')
    const bad = [...src, ...dst].find((x) => !isIp(x))
    if (bad) {
      tasks.push(`    # ${r.name}: TODO "${bad}" is not an IP/CIDR — create an ipset and use match: set instead`)
      continue
    }
    const ports = splitPorts(r).map((p) => p.replace('-', ':'))
    const base = [`      chain: ${r.direction === 'Inbound' ? 'INPUT' : 'OUTPUT'}`]
    if (src.length) base.push(`      source: ${yq(src.join(','))}`)
    if (dst.length) base.push(`      destination: ${yq(dst.join(','))}`)
    if (r.protocol !== 'ANY') base.push(`      protocol: ${r.protocol.toLowerCase()}`)
    if (ports.length === 1) base.push(`      destination_port: ${yq(ports[0])}`)
    else if (ports.length > 1) base.push(`      destination_ports: [${ports.map(yq).join(', ')}]`)
    const task = (name: string, extra: string[]) =>
      [`    - name: ${yq(name)}`, '      ansible.builtin.iptables:', ...base.map((l) => `  ${l}`), ...extra.map((l) => `        ${l}`)].join('\n')
    if (r.logging) tasks.push(task(`${r.name} (log)`, [`comment: ${yq(r.name)}`, 'jump: LOG', `log_prefix: ${yq(`${r.name}: `)}`]))
    tasks.push(task(r.name, [`comment: ${yq(r.name)}`, `jump: ${{ ALLOW: 'ACCEPT', DROP: 'DROP', REJECT: 'REJECT' }[r.action]}`]))
  }
  return `---
- name: ${yq(`${policyName} (iptables)`)}
  hosts: all
  become: true
  # Rules are appended in order. IPv4 only. Persist with the netfilter-persistent / iptables-services packages.
  tasks:
${tasks.join('\n\n')}
`
}

const nftablesAnsible = (rules: Rule[], opts: Options) => {
  const table = slug(opts.policyName).replace(/-/g, '_')
  const body = nftables(rules, opts)
    .split('\n')
    .filter((l) => !l.startsWith('#!'))
    .map((l) => (l ? `          ${l}` : ''))
    .join('\n')
  const dest = `/etc/nftables.d/${table}.nft`
  return `---
- name: ${yq(`${opts.policyName} (nftables)`)}
  hosts: all
  become: true
  # Include the directory from /etc/nftables.conf:  include "/etc/nftables.d/*.nft"
  tasks:
    - name: Ensure /etc/nftables.d exists
      ansible.builtin.file:
        path: /etc/nftables.d
        state: directory
        mode: '0755'

    - name: Install ruleset
      ansible.builtin.copy:
        dest: ${dest}
        mode: '0644'
        validate: nft -c -f %s
        content: |
          add table inet ${table}
          flush table inet ${table}
${body}
      notify: Reload nftables

  handlers:
    - name: Reload nftables
      ansible.builtin.command: nft -f ${dest}
`
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

const nsxPs = (rules: Rule[], { policyName }: Options) => {
  const id = slug(policyName)
  const nsxRules = active(rules).map((r, i) => {
    const src = prefixes(r.source, 'nsx')
    const dst = prefixes(r.destination, 'nsx')
    const svc = SERVICES[r.service]
    const ports = splitPorts(r)
    const rule: Record<string, unknown> = {
      id: slug(r.name),
      display_name: r.name,
      sequence_number: (i + 1) * 10,
      action: r.action,
      direction: r.direction === 'Inbound' ? 'IN' : 'OUT',
      source_groups: src.length ? src : ['ANY'],
      destination_groups: dst.length ? dst : ['ANY'],
      scope: r.scope.trim() ? r.scope.split(/\s*,\s*/) : ['ANY'],
      logged: r.logging,
    }
    if (svc?.nsx) {
      rule.services = [`/infra/services/${svc.nsx}`]
    } else if (r.protocol === 'ICMP') {
      rule.services = ['/infra/services/ICMP-ALL']
    } else if (r.protocol !== 'ANY' && ports.length) {
      rule.services = ['ANY']
      rule.service_entries = [
        { resource_type: 'L4PortSetServiceEntry', display_name: `${r.protocol.toLowerCase()}-${ports.join('_')}`, l4_protocol: r.protocol, destination_ports: ports },
      ]
    } else {
      rule.services = ['ANY']
    }
    if (r.notes.trim()) rule.notes = r.notes.trim()
    return rule
  })
  const body = JSON.stringify({ display_name: policyName, category: 'Application', rules: nsxRules }, null, 2)
  return `$nsx  = 'https://<nsx-manager>'
$cred = Get-Credential

$body = @'
${body}
'@

# PATCH creates or updates the whole policy in one call (idempotent).
Invoke-RestMethod -Method Patch -Uri "$nsx/policy/api/v1/infra/domains/default/security-policies/${id}" \`
  -Credential $cred -ContentType 'application/json' -Body $body -SkipCertificateCheck
`
}

const panos1 = (rules: Rule[], { policyName }: Options) => {
  const list = (a: string[]) => `[${a.map((x) => `"${x}"`).join(', ')}]`
  const addr = (v: string) => {
    const p = prefixes(v, 'nsx')
    return p.length ? p : ['any']
  }
  const zones = (v: string) => (v.trim() ? v.split(/\s*,\s*/) : ['any'])
  const svcs = new Map<string, { proto: string; port: string }>()
  const svcRefs = (r: Rule): string[] => {
    if (r.protocol === 'ICMP') return ['any']
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

  const body = active(rules).map((r) => {
    const act = { ALLOW: 'allow', DROP: 'drop', REJECT: 'reset-both' }[r.action]
    const bad = [...addr(r.source), ...addr(r.destination)].filter((x) => x !== 'any' && !isIp(x))
    const lines = [
      `    name                  = "${r.name}"`,
      `    source_zones          = ${list(zones(r.srcZone))}`,
      `    source_addresses      = ${list(addr(r.source))}`,
      '    source_users          = ["any"]',
      `    destination_zones     = ${list(zones(r.dstZone))}`,
      `    destination_addresses = ${list(addr(r.destination))}`,
      `    applications          = ${list(apps(r))}`,
      `    services              = [${svcRefs(r).map((n) => (svcs.has(n) ? `panos_service_object.${n}.name` : `"${n}"`)).join(', ')}]`,
      '    categories            = ["any"]',
      `    action                = "${act}"`,
      `    log_end               = ${r.logging}`,
    ]
    if (r.notes.trim()) lines.push(`    description           = "${r.notes.trim()}"`)
    const note = bad.length ? `    # TODO: ${bad.map((b) => `"${b}"`).join(', ')} must exist as a panos_address_object / address group\n` : ''
    return `\n  rule {\n${note}${lines.join('\n')}\n  }`
  })

  const objs = [...svcs.entries()].map(
    ([name, s]) => `resource "panos_service_object" "${name}" {
  name             = "${name}"
  protocol         = "${s.proto}"
  destination_port = "${s.port}"
}
`,
  )
  return `terraform {
  required_providers {
    panos = {
      source  = "PaloAltoNetworks/panos"
      version = "~> 1.11"
    }
  }
}

${objs.join('\n')}${objs.length ? '\n' : ''}resource "panos_security_rule_group" "${slug(policyName).replace(/-/g, '_')}" {
  position_keyword = "bottom"
${body.join('\n')}
}
`
}

type AclAddr = { any: true } | { host: string } | { net: string; wc: string }

const aclAddr = (x: string): AclAddr => {
  if (x === 'any') return { any: true }
  const w = wildcard(x)
  if (w.startsWith('host ')) return { host: w.slice(5) }
  const [net, wc] = w.split(' ')
  return { net, wc }
}

interface Ace {
  rule: string
  first: boolean
  grant: 'permit' | 'deny'
  proto: string
  src: AclAddr
  dst: AclAddr
  eq?: string
  range?: [string, string]
  log: boolean
}

interface AclPlan {
  name: string
  direction: 'in' | 'out'
  aces: Ace[]
  todos: string[]
}

const ciscoPlan = (rules: Rule[], policyName: string): AclPlan[] => {
  const plans: AclPlan[] = []
  for (const dir of ['Inbound', 'Outbound'] as const) {
    const subset = active(rules).filter((r) => r.direction === dir)
    if (!subset.length) continue
    const plan: AclPlan = { name: `${slug(policyName)}-${dir === 'Inbound' ? 'in' : 'out'}`, direction: dir === 'Inbound' ? 'in' : 'out', aces: [], todos: [] }
    for (const r of subset) {
      const src = prefixes(r.source, 'nsx')
      const dst = prefixes(r.destination, 'nsx')
      const bad = [...src, ...dst].find((x) => !isIp(x))
      if (bad) {
        plan.todos.push(`${r.name}: "${bad}" is not an IP/CIDR — use an object-group`)
        continue
      }
      const proto = { TCP: 'tcp', UDP: 'udp', ICMP: 'icmp', ANY: 'ip' }[r.protocol]
      const ports = splitPorts(r)
      const specs: { eq?: string; range?: [string, string] }[] = ports.length
        ? ports.map((p) => (p.includes('-') ? { range: p.split('-') as [string, string] } : { eq: p }))
        : [{}]
      let first = true
      for (const s of src.length ? src : ['any']) {
        for (const d of dst.length ? dst : ['any']) {
          for (const spec of specs) {
            plan.aces.push({ rule: r.name, first, grant: r.action === 'ALLOW' ? 'permit' : 'deny', proto, src: aclAddr(s), dst: aclAddr(d), ...spec, log: r.logging })
            first = false
          }
        }
      }
    }
    plans.push(plan)
  }
  return plans
}

const ciscoAnsible = (rules: Rule[], { policyName }: Options) => {
  const addrYaml = (a: AclAddr, pad: string, port?: Ace): string[] => {
    const lines = 'any' in a ? [`${pad}any: true`] : 'host' in a ? [`${pad}host: ${a.host}`] : [`${pad}address: ${a.net}`, `${pad}wildcard_bits: ${a.wc}`]
    if (port?.eq) lines.push(`${pad}port_protocol:`, `${pad}  eq: ${yq(port.eq)}`)
    if (port?.range) lines.push(`${pad}port_protocol:`, `${pad}  range:`, `${pad}    start: ${yq(port.range[0])}`, `${pad}    end: ${yq(port.range[1])}`)
    return lines
  }
  const acls = ciscoPlan(rules, policyName).map((plan) => {
    const lines: string[] = [`              - name: ${plan.name}`, '                acl_type: extended', '                aces:']
    for (const t of plan.todos) lines.push(`                  # TODO: ${t}`)
    for (const ace of plan.aces) {
      if (ace.first) lines.push(`                  - remarks: [${yq(ace.rule)}]`)
      lines.push(
        `                  - grant: ${ace.grant}`,
        `                    protocol: ${ace.proto}`,
        '                    source:',
        ...addrYaml(ace.src, '                      '),
        '                    destination:',
        ...addrYaml(ace.dst, '                      ', ace),
      )
      if (ace.log) lines.push('                    log:', '                      set: true')
    }
    return lines.join('\n')
  })
  return `---
- name: ${yq(`${policyName} (Cisco IOS ACLs)`)}
  hosts: all
  gather_facts: false
  connection: ansible.netcommon.network_cli
  vars:
    ansible_network_os: cisco.ios.ios
  # Requires: ansible-galaxy collection install cisco.ios ansible.netcommon
  tasks:
    - name: Configure extended ACLs
      cisco.ios.ios_acls:
        state: replaced
        config:
          - afi: ipv4
            acls:
${acls.join('\n')}

    # Attach with cisco.ios.ios_acl_interfaces, e.g. access_groups: [{ name: <acl>, direction: in }]
`
}

const ciscoTerraform = (rules: Rule[], { policyName }: Options) => {
  const addr = (prefix: 'source' | 'destination', a: AclAddr): string[] =>
    'any' in a ? [`${prefix}_any = true`] : 'host' in a ? [`${prefix}_host = "${a.host}"`] : [`${prefix}_prefix = "${a.net}"`, `${prefix}_prefix_mask = "${a.wc}"`]
  const resources = ciscoPlan(rules, policyName).map((plan) => {
    let seq = 0
    const entries: string[] = []
    for (const ace of plan.aces) {
      if (ace.first) {
        seq += 10
        entries.push(`    {\n      sequence = ${seq}\n      remark   = "${ace.rule}"\n    }`)
      }
      seq += 10
      const lines = [`sequence = ${seq}`, `ace_rule_action = "${ace.grant}"`, `ace_rule_protocol = "${ace.proto}"`, ...addr('source', ace.src), ...addr('destination', ace.dst)]
      if (ace.eq) lines.push(`destination_port_equal = "${ace.eq}"`)
      if (ace.range) lines.push(`destination_port_range_from = "${ace.range[0]}"`, `destination_port_range_to = "${ace.range[1]}"`)
      if (ace.log) lines.push('log = true')
      entries.push(`    {\n${lines.map((l) => `      ${l}`).join('\n')}\n    }`)
    }
    const todo = plan.todos.map((t) => `# TODO: ${t}\n`).join('')
    return `${todo}resource "iosxe_access_list_extended" "${plan.name.replace(/-/g, '_')}" {
  name = "${plan.name}"
  entries = [
${entries.join(',\n')}
  ]
}

# Attach with iosxe_interface_ethernet: ip_access_group_${plan.direction}_enable = true, ip_access_group_${plan.direction} = "${plan.name}"
`
  })
  return `terraform {
  required_providers {
    iosxe = {
      source  = "CiscoDevNet/iosxe"
      version = "~> 1.0"
    }
  }
}

# IOS XE only (NETCONF/RESTCONF). Set credentials via IOSXE_USERNAME / IOSXE_PASSWORD.
provider "iosxe" {
  host = "<device-ip>"
}

${resources.join('\n')}`
}

const panosAnsible = (rules: Rule[], { policyName }: Options) => {
  const list = (a: string[]) => `[${a.map(yq).join(', ')}]`
  const addr = (v: string) => {
    const p = prefixes(v, 'nsx')
    return p.length ? p : ['any']
  }
  const zones = (v: string) => (v.trim() ? v.split(/\s*,\s*/) : ['any'])
  const svcs = new Map<string, { proto: string; port: string }>()
  const svcRefs = (r: Rule): string[] => {
    if (r.protocol === 'ICMP') return ['any']
    const ports = splitPorts(r)
    if (!ports.length) return ['any']
    return ports.map((p) => {
      const proto = r.protocol === 'ANY' ? 'tcp' : r.protocol.toLowerCase()
      const name = `${proto}-${p}`
      svcs.set(name, { proto, port: p })
      return name
    })
  }
  const ruleTasks = active(rules).map((r) => {
    const act = { ALLOW: 'allow', DROP: 'drop', REJECT: 'reset-both' }[r.action]
    const lines = [
      `    - name: ${yq(r.name)}`,
      '      paloaltonetworks.panos.panos_security_rule:',
      '        provider: "{{ provider }}"',
      `        rule_name: ${yq(r.name)}`,
      `        source_zone: ${list(zones(r.srcZone))}`,
      `        source_ip: ${list(addr(r.source))}`,
      `        destination_zone: ${list(zones(r.dstZone))}`,
      `        destination_ip: ${list(addr(r.destination))}`,
      `        application: ${list(r.protocol === 'ICMP' ? ['icmp', 'ping'] : ['any'])}`,
      `        service: ${list(svcRefs(r))}`,
      `        action: ${act}`,
      `        log_end: ${r.logging}`,
    ]
    if (r.notes.trim()) lines.push(`        description: ${yq(r.notes.trim())}`)
    return lines.join('\n')
  })
  const svcTasks = [...svcs.entries()].map(([name, s]) =>
    [`    - name: ${yq(`Service ${name}`)}`, '      paloaltonetworks.panos.panos_service_object:', '        provider: "{{ provider }}"', `        name: ${yq(name)}`, `        protocol: ${s.proto}`, `        destination_port: ${yq(s.port)}`].join('\n'),
  )
  return `---
- name: ${yq(`${policyName} (Palo Alto)`)}
  hosts: all
  connection: local
  gather_facts: false
  # Requires: ansible-galaxy collection install paloaltonetworks.panos  (and pip install pan-os-python)
  vars:
    provider:
      ip_address: "{{ ansible_host }}"
      username: "{{ panos_username }}"
      password: "{{ panos_password }}"
  tasks:
${[...svcTasks, ...ruleTasks].join('\n\n')}

    # Rules are created in order at the bottom of the rulebase; commit applies them.
    - name: Commit
      paloaltonetworks.panos.panos_commit_firewall:
        provider: "{{ provider }}"
`
}

export const TARGETS: Target[] = [
  { id: 'nsx', platform: 'nsx', label: 'NSX DFW', format: 'Terraform', filename: 'main.tf', generate: nsx },
  { id: 'nsx-ps', platform: 'nsx', label: 'NSX DFW', format: 'PowerShell', filename: 'nsx-policy.ps1', generate: nsxPs },
  { id: 'sdn-ps', platform: 'sdn', label: 'SDN ACL', format: 'PowerShell', filename: 'sdn-acl.ps1', generate: sdnPs },
  { id: 'azl-nsg', platform: 'azl', label: 'Azure Local NSG', format: 'az CLI', filename: 'azl-nsg.ps1', generate: azl },
  { id: 'azl-bicep', platform: 'azl', label: 'Azure Local NSG', format: 'Bicep', filename: 'azl-nsg.bicep', generate: azlBicep },
  { id: 'windows', platform: 'windows', label: 'Windows Firewall', format: 'PowerShell', filename: 'windows-firewall.ps1', generate: windows },
  { id: 'nftables', platform: 'nftables', label: 'nftables', format: 'nft', filename: 'rules.nft', generate: nftables },
  { id: 'nftables-ansible', platform: 'nftables', label: 'nftables', format: 'Ansible', filename: 'nftables.yml', generate: nftablesAnsible },
  { id: 'iptables', platform: 'iptables', label: 'iptables', format: 'Shell', filename: 'iptables.sh', generate: iptables },
  { id: 'iptables-ansible', platform: 'iptables', label: 'iptables', format: 'Ansible', filename: 'iptables.yml', generate: iptablesAnsible },
  { id: 'firewalld', platform: 'firewalld', label: 'firewalld', format: 'Shell', filename: 'firewalld.sh', generate: firewalld },
  { id: 'firewalld-ansible', platform: 'firewalld', label: 'firewalld', format: 'Ansible', filename: 'firewalld.yml', generate: firewalldAnsible },
  { id: 'cisco', platform: 'cisco', label: 'Cisco ACL', format: 'IOS', filename: 'acl.ios', generate: cisco },
  { id: 'cisco-ansible', platform: 'cisco', label: 'Cisco ACL', format: 'Ansible', filename: 'cisco-acl.yml', generate: ciscoAnsible },
  { id: 'cisco-tf', platform: 'cisco', label: 'Cisco ACL', format: 'Terraform (IOS XE)', filename: 'cisco-acl.tf', generate: ciscoTerraform },
  { id: 'fmc', platform: 'fmc', label: 'Cisco FMC', format: 'Terraform', filename: 'fmc.tf', generate: fmc },
  { id: 'panos', platform: 'panos', label: 'Palo Alto', format: 'Terraform 2.x', filename: 'panos.tf', generate: panos },
  { id: 'panos-ansible', platform: 'panos', label: 'Palo Alto', format: 'Ansible', filename: 'panos.yml', generate: panosAnsible },
  { id: 'panos-1x', platform: 'panos', label: 'Palo Alto', format: 'Terraform 1.x', filename: 'panos-1x.tf', generate: panos1 },
]

export const PLATFORMS = TARGETS.filter((t, i) => TARGETS.findIndex((x) => x.platform === t.platform) === i).map((t) => ({ platform: t.platform, label: t.label }))
