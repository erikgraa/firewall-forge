import { describe, expect, it } from 'vitest'
import { parseCsv } from './csv'
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
