import { describe, expect, it } from 'vitest'
import { csvColumns, csvExample, parseCsv, toCsv } from './csv'
import { EXTRA_COLUMNS } from './columns'
import { jsonExample, parseJson, toJson } from './json'
import { TARGETS } from './generators'
import { blankRule, sampleRules } from './model'
import type { Rule } from './model'
import { decodeState, encodeState } from './share'
import { validate } from './validate'

const opts = { policyName: 'generated' }
const out = (id: string, rules: Rule[] = sampleRules(), o = opts) => TARGETS.find((t) => t.id === id)!.generate(rules, o)
const rule = (over: Partial<Rule>): Rule => ({ ...blankRule(), name: 'r1', ...over })

describe('generators (snapshots)', () => {
  for (const t of TARGETS) {
    it(`${t.id} output is stable`, () => {
      expect(out(t.id)).toMatchSnapshot()
    })
  }
})

describe('generators (behaviour)', () => {
  it('skips disabled rules everywhere', () => {
    const rules = [rule({ name: 'on' }), rule({ name: 'off', enabled: false })]
    for (const t of TARGETS) {
      const text = out(t.id, rules)
      expect(text).toContain('on')
      expect(text).not.toContain('off"')
      expect(text).not.toContain("'off'")
    }
  })

  it('expands RFC1918 into three prefixes', () => {
    const text = out('cisco', [rule({ source: 'Private networks (RFC1918)', destination: '10.1.1.0/24' })])
    expect(text).toContain('10.0.0.0 0.255.255.255')
    expect(text).toContain('172.16.0.0 0.15.255.255')
    expect(text).toContain('192.168.0.0 0.0.255.255')
  })

  it('cisco converts single hosts to host form', () => {
    expect(out('cisco', [rule({ destination: '1.1.1.1', ports: '53', protocol: 'UDP', service: 'Custom' })])).toContain('host 1.1.1.1 eq 53')
  })

  it('nsx maps well-known services and flags unknown ones', () => {
    expect(out('nsx', [rule({ service: 'HTTPS (TCP 443)' })])).toContain('/infra/services/HTTPS')
    expect(out('nsx', [rule({ service: 'SMB (TCP 445)', ports: '445' })])).toContain('TODO')
  })

  it('azure local bicep emits child security rules with explicit priorities', () => {
    const text = out('azl-bicep', [rule({ name: 'web-in', source: '10.0.0.0/8', destination: '10.1.1.0/24', priority: '250' }), rule({ name: 'ping', protocol: 'ICMP', ports: '', action: 'DROP' })])
    expect(text).toContain("'Microsoft.AzureStackHCI/networkSecurityGroups/securityRules@2025-09-01-preview'")
    expect(text).toContain('parent: generated')
    expect(text).toContain('priority: 250')
    expect(text).toContain("access: 'Deny'")
    expect(text).toContain("protocol: 'Icmp'")
    expect(text).toContain("destinationPortRanges: ['443']")
  })

  it('azure local priority honours explicit values', () => {
    expect(out('azl-nsg', [rule({ priority: '250' })])).toContain('--priority 250')
  })

  it('windows swaps port flags by direction', () => {
    expect(out('windows', [rule({ direction: 'Inbound' })])).toContain('-LocalPort')
    expect(out('windows', [rule({ direction: 'Outbound' })])).toContain('-RemotePort')
  })

  it('firewalld honours per-rule permanence and orders the reload before runtime rules', () => {
    const text = out('firewalld', [
      rule({ name: 'keep', source: '10.0.0.0/8', destination: '10.1.1.1' }),
      rule({ name: 'temp', source: '10.0.0.0/8', destination: '10.1.1.2', permanent: false }),
    ])
    const keep = text.indexOf("--permanent --zone=public --add-rich-rule='rule priority=\"10\"")
    const reload = text.indexOf('firewall-cmd --reload')
    const temp = text.indexOf("firewall-cmd --zone=public --add-rich-rule='rule priority=\"20\"")
    expect(keep).toBeGreaterThanOrEqual(0)
    expect(reload).toBeGreaterThan(keep)
    expect(temp).toBeGreaterThan(reload)
    expect(text).toContain('# temp (runtime only)')
    expect(text).toContain('--runtime-to-permanent')
  })

  it('firewalld with only runtime rules has no reload', () => {
    const text = out('firewalld', [rule({ source: '10.0.0.0/8', destination: '10.1.1.2', permanent: false })])
    expect(text).not.toContain('--reload')
    expect(text).not.toMatch(/--permanent/)
  })
  it('nftables and iptables route by direction', () => {
    const rules = [rule({ name: 'in', direction: 'Inbound' }), rule({ name: 'out', direction: 'Outbound' })]
    expect(out('iptables', rules)).toMatch(/-A INPUT[^\n]*"in"/)
    expect(out('iptables', rules)).toMatch(/-A OUTPUT[^\n]*"out"/)
    expect(out('nftables', rules)).toContain('chain input')
    expect(out('nftables', rules)).toContain('chain output')
  })

  it('nftables never emits an "any" protocol match', () => {
    expect(out('nftables', [rule({ protocol: 'ANY', ports: '', action: 'DROP' })])).not.toContain('l4proto any')
  })

  it('fmc maps actions, literals, zones and named networks', () => {
    const text = out('fmc', [
      rule({ action: 'REJECT', source: 'corp-net', srcZone: 'inside', destination: '10.1.1.0/24', dstZone: 'outside', protocol: 'UDP', service: 'Custom', ports: '53', logging: true }),
      rule({ name: 'ping', protocol: 'ICMP', ports: '' }),
    ])
    expect(text).toContain('action = "BLOCK_RESET"')
    expect(text).toContain('{ value = "10.1.1.0/24" }')
    expect(text).toContain('data.fmc_security_zone.inside.id')
    expect(text).toContain('data "fmc_network" "corp_net"')
    expect(text).toContain('protocol = "17", port = "53"')
    expect(text).toContain('ICMPv4PortLiteral')
    expect(text).toContain('log_connection_end = true')
  })

  it('firewalld ansible: module for zones, command for policies, reload before runtime rules', () => {
    const text = out('firewalld-ansible', [
      rule({ name: 'keep', source: '10.0.0.0/8', destination: '10.1.1.1' }),
      rule({ name: 'temp', source: '10.0.0.0/8', destination: '10.1.1.2', permanent: false }),
      rule({ name: 'egress', direction: 'Outbound', source: '10.0.0.0/8', destination: '10.2.2.2' }),
    ])
    expect(text).toContain('ansible.posix.firewalld:')
    expect(text).toContain('permanent: false')
    expect(text).toContain("argv: ['firewall-cmd', '--permanent', '--policy', 'generated-out', '--add-rich-rule'")
    expect(text.indexOf("'Reload firewalld")).toBeGreaterThan(text.indexOf("name: 'keep'"))
    expect(text.indexOf("name: 'temp'")).toBeGreaterThan(text.indexOf("'Reload firewalld"))
  })

  it('iptables ansible uses multiport lists and log tasks', () => {
    const text = out('iptables-ansible', [rule({ ports: '80,443', service: 'Custom', logging: true })])
    expect(text).toContain("destination_ports: ['80', '443']")
    expect(text).toContain('jump: LOG')
  })

  it('nftables ansible embeds a flushed, validated ruleset with consistent indentation', () => {
    const text = out('nftables-ansible')
    expect(text).toContain('validate: nft -c -f %s')
    expect(text).toContain('flush table inet generated')
    for (const line of text.split('\n').slice(text.split('\n').findIndex((l) => l.includes('content: |')) + 1)) {
      if (line.trim() === '' || line.startsWith('      notify')) continue
      if (line.startsWith('      notify') || line.startsWith('  handlers')) break
      expect(line.startsWith('          ')).toBe(true)
    }
  })

  it('nsx powershell emits a PATCH with inline service entries for unknown services', () => {
    const text = out('nsx-ps', [rule({ service: 'SMB (TCP 445)', ports: '445' })])
    expect(text).toContain('Invoke-RestMethod -Method Patch')
    expect(text).toContain('L4PortSetServiceEntry')
    const json = text.slice(text.indexOf("@'\n") + 3, text.indexOf("\n'@"))
    expect(JSON.parse(json).rules[0].service_entries[0].destination_ports).toEqual(['445'])
  })

  it('panos 1.x uses the rule group resource', () => {
    expect(out('panos-1x')).toContain('resource "panos_security_rule_group"')
    expect(out('panos-1x')).toContain('~> 1.11')
  })

  it('every target belongs to a platform with at least one format', () => {
    for (const t of TARGETS) expect(TARGETS.filter((x) => x.platform === t.platform).length).toBeGreaterThan(0)
    expect(new Set(TARGETS.map((t) => t.id)).size).toBe(TARGETS.length)
  })

  it('cisco ansible/terraform expand ports and wildcards from one plan', () => {
    const rules = [rule({ source: '10.0.0.0/8', destination: '10.1.1.1', service: 'Custom', ports: '80,5985-5986', logging: true })]
    const ans = out('cisco-ansible', rules)
    expect(ans).toContain('cisco.ios.ios_acls:')
    expect(ans).toContain('wildcard_bits: 0.255.255.255')
    expect(ans).toContain('host: 10.1.1.1')
    expect(ans).toContain("start: '5985'")
    expect(ans).toContain('set: true')
    const tf = out('cisco-tf', rules)
    expect(tf).toContain('resource "iosxe_access_list_extended"')
    expect(tf).toContain('destination_port_range_from = "5985"')
    expect(tf).toContain('log = true')
  })

  it('panos ansible creates service objects before rules and ends with a commit', () => {
    const text = out('panos-ansible', [rule({ ports: '443' })])
    expect(text.indexOf('panos_service_object')).toBeLessThan(text.indexOf('panos_security_rule'))
    expect(text).toContain('panos_commit_firewall')
    expect(text).toContain("service: ['tcp-443']")
  })

  it('nsx sdk uses the VMware.Sdk.Nsx.Policy cmdlets with inline service entries', () => {
    const text = out('nsx-sdk', [rule({ name: "it's", service: 'SMB (TCP 445)', ports: '445', logging: true })])
    expect(text).toContain('Connect-NsxServer')
    expect(text).toContain('Initialize-L4PortSetServiceEntry')
    expect(text).toContain("-DisplayName 'it''s'")
    expect(text).toContain('-ServiceEntries @($svc0_0)')
    expect(text).toContain('Invoke-PatchSecurityPolicyForDomain -DomainId')
  })

  it('azure firewall groups consecutive same-action rules into collections and skips unresolved names', () => {
    const rules = [
      rule({ name: 'a', source: '10.0.0.0/8', destination: '10.1.1.1' }),
      rule({ name: 'b', source: '10.0.0.0/8', destination: 'login.microsoftonline.com' }),
      rule({ name: 'c', source: 'corp', destination: '10.1.1.1' }),
      rule({ name: 'd', action: 'DROP', source: '10.0.0.0/8', destination: '10.9.9.9' }),
    ]
    const tf = out('azfw-tf', rules)
    expect(tf.match(/network_rule_collection \{/g)).toHaveLength(2)
    expect(tf).toContain('destination_fqdns     = ["login.microsoftonline.com"]')
    expect(tf).toContain('# TODO: c: "corp"')
    expect(tf).not.toContain('name                  = "c"')
    const bicep = out('azfw-bicep', rules)
    expect(bicep).toContain("type: 'Deny'")
    expect(bicep).toContain("ruleType: 'NetworkRule'")
  })

  it('bicep outputs escape single quotes', () => {
    expect(out('azfw-bicep', [rule({ name: "it's", source: '10.0.0.0/8', destination: '10.1.1.1', notes: "a'b" })])).toContain("name: 'it\\'s'")
    expect(out('azl-bicep', [rule({ name: "it's", notes: "a'b" })])).toContain("description: 'a\\'b'")
  })

  it('panos creates service objects and references them', () => {
    const text = out('panos', [rule({ ports: '443' })])
    expect(text).toContain('resource "panos_service" "tcp-443"')
    expect(text).toContain('panos_service.tcp-443.name')
  })

})

describe('validate', () => {
  it('flags empty and duplicate names, bad ports and CIDRs', () => {
    const issues = validate([rule({ name: '' }), rule({ name: 'a' }), rule({ name: 'a' }), rule({ name: 'b', ports: '99999' }), rule({ name: 'c', source: '300.1.1.1' })])
    const text = issues.map((i) => i.message).join('\n')
    expect(text).toContain('no name')
    expect(text).toContain('Duplicate rule name "a"')
    expect(text).toContain('out of range')
    expect(text).toContain('invalid source')
  })

  it('warns about unsupported reject on windows and cisco only', () => {
    const rules = [rule({ action: 'REJECT' })]
    expect(validate(rules, 'windows').some((i) => i.message.includes('no reject'))).toBe(true)
    expect(validate(rules, 'cisco').some((i) => i.message.includes('no reject'))).toBe(true)
    expect(validate(rules, 'firewalld').some((i) => i.message.includes('no reject'))).toBe(false)
  })

  it('warns that windows blocks override allows', () => {
    const rules = [rule({ name: 'a' }), rule({ name: 'b', action: 'DROP' })]
    expect(validate(rules, 'windows').some((i) => i.message.includes('before Allow'))).toBe(true)
  })

  it('warns about default-accept chains on nftables', () => {
    expect(validate([rule({})], 'nftables').some((i) => i.message.includes('default-deny'))).toBe(true)
  })

  it('does not treat well-known endpoint names as unresolved', () => {
    const rules = [rule({ destination: 'Public DNS (1.1.1.1, 8.8.8.8)' }), rule({ name: 'b', source: 'Internet' })]
    expect(validate(rules, 'cisco').some((i) => i.message.includes('Names instead'))).toBe(false)
    expect(validate([rule({ destination: 'web-grp' })], 'cisco').some((i) => i.message.includes('Names instead'))).toBe(true)
  })
})

describe('csv import', () => {
  it('parses services, protocols and directions', () => {
    const rules = parseCsv('name,source,destination,service,ports,action,direction\napp,10.0.0.0/24,web,HTTPS (TCP 443),,ALLOW,Inbound\nblock,Any,Any,TCP,445,DROP,Outbound')
    expect(rules).toHaveLength(2)
    expect(rules[0].ports).toBe('443')
    expect(rules[1]).toMatchObject({ protocol: 'TCP', ports: '445', action: 'DROP', direction: 'Outbound' })
  })
  it('exports CSV that imports back to the same rules, including quoted values', () => {
    const rules = [
      rule({ name: 'web', source: 'Private networks (RFC1918)', destination: '10.1.1.0/24', service: 'HTTPS (TCP 443)', ports: '443' }),
      rule({ name: 'dns', destination: 'Public DNS (1.1.1.1, 8.8.8.8)', service: 'DNS (UDP 53)', protocol: 'UDP', ports: '53', direction: 'Outbound' }),
      rule({ name: 'smb', service: 'Custom', protocol: 'TCP', ports: '445,139', action: 'DROP' }),
    ]
    const text = toCsv(rules)
    expect(text.split('\n')[0]).toBe('name,source,destination,service,ports,action,direction')
    expect(text).toContain('"Public DNS (1.1.1.1, 8.8.8.8)"')
    const back = parseCsv(text)
    expect(back).toHaveLength(3)
    expect(back.map((r) => [r.name, r.source, r.destination, r.service, r.protocol, r.ports, r.action, r.direction])).toEqual(
      rules.map((r) => [r.name, r.source, r.destination, r.service, r.protocol, r.ports, r.action, r.direction]),
    )
  })

  it('each target gets its own columns, and its example round-trips', () => {
    expect(csvColumns(EXTRA_COLUMNS['azl-nsg']).join()).toBe('name,source,destination,service,ports,action,direction,priority')
    expect(csvColumns(EXTRA_COLUMNS.nsx).join()).toBe('name,source,destination,service,ports,action,direction,scope,logging,notes')
    expect(csvColumns(EXTRA_COLUMNS.firewalld)).toContain('permanent')
    for (const t of TARGETS) {
      const extras = EXTRA_COLUMNS[t.id]
      expect(parseCsv(csvExample(extras), extras)).toHaveLength(3)
    }
  })

  it('exports and re-imports per-target options', () => {
    const extras = EXTRA_COLUMNS.firewalld
    const rules = [rule({ name: 'a', source: '10.0.0.0/8', destination: '10.1.1.1', zone: 'dmz', permanent: false, logging: true })]
    const text = toCsv(rules, extras)
    expect(text.split('\n')[0]).toBe('name,source,destination,service,ports,action,direction,zone,permanent,logging')
    const [back] = parseCsv(text, extras)
    expect(back).toMatchObject({ zone: 'dmz', permanent: false, logging: true })
  })

  it('matches header columns by name in any order and ignores unknown columns', () => {
    const [r] = parseCsv('direction,bogus,name,priority,action,destination,source,service,ports\nOutbound,x,r1,250,drop,10.1.1.1,Any,TCP,8080')
    expect(r).toMatchObject({ name: 'r1', priority: '250', action: 'DROP', direction: 'Outbound', destination: '10.1.1.1', protocol: 'TCP', ports: '8080' })
  })

  it('reads headerless rows positionally using the target columns', () => {
    const [r] = parseCsv('r1,Any,Any,TCP,22,ALLOW,Inbound,110', EXTRA_COLUMNS['azl-nsg'])
    expect(r).toMatchObject({ name: 'r1', ports: '22', priority: '110' })
  })
})
describe('json import/export', () => {
  it('round-trips every field losslessly, including enabled and per-target options', () => {
    const rules = [rule({ name: 'a', enabled: false, zone: 'dmz', permanent: false, logging: true, priority: '250', scope: 'grp', notes: 'n', profile: 'Domain', srcZone: 'in', dstZone: 'out' })]
    const { rules: back, error } = parseJson(toJson(rules, { target: 'nsx', policyName: 'p' }))
    expect(error).toBeUndefined()
    expect(back.map(({ id: _id, ...r }) => r)).toEqual(rules.map(({ id: _id, ...r }) => r))
  })

  it('accepts a bare array and ignores unknown keys and invalid values', () => {
    const { rules } = parseJson('[{"name":"x","action":"EXPLODE","logging":"yes","bogus":1,"direction":"Outbound"}]')
    expect(rules[0]).toMatchObject({ name: 'x', action: 'ALLOW', logging: false, direction: 'Outbound' })
  })

  it('reports readable errors', () => {
    expect(parseJson('{nope').error).toContain('Not valid JSON')
    expect(parseJson('{"rules":5}').error).toContain('array')
    expect(parseJson('[]').error).toContain('No rules')
  })

  it('the built-in example parses', () => {
    expect(parseJson(jsonExample({ target: 'cisco', policyName: 'demo' })).rules).toHaveLength(3)
  })
})

describe('share links', () => {
  it('round-trips state and keeps links short', async () => {
    const rules = sampleRules()
    const fragment = await encodeState({ rules, target: 'cisco', policyName: 'demo' })
    expect(fragment.startsWith('s=1.')).toBe(true)
    expect(fragment.length).toBeLessThan(600)
    const back = await decodeState(`#${fragment}`)
    expect(back?.target).toBe('cisco')
    expect(back?.policyName).toBe('demo')
    expect(back?.rules.map(({ id: _id, ...r }) => r)).toEqual(rules.map(({ id: _id, ...r }) => r))
  })

  it('rejects garbage and unknown versions', async () => {
    expect(await decodeState('#s=1.@@@')).toBeNull()
    expect(await decodeState('#s=9.abc')).toBeNull()
    expect(await decodeState('#other')).toBeNull()
  })
})
