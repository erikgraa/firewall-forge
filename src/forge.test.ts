import { describe, expect, it } from 'vitest'
import { csvColumns, csvExample, parseCsv, toCsv } from './csv'
import { EXTRA_COLUMNS } from './columns'
import { jsonExample, parseJson, toJson } from './json'
import { TARGETS } from './generators'
import providers from './providers.json'
import { requiredProviders } from './providers'
import { NSX_CATEGORIES, blankRule, normalizeNsxCategory, sampleRules } from './model'
import type { Rule } from './model'
import { decodeState, encodeState } from './share'
import { validate } from './validate'

const opts: { policyName: string; nsxProject?: string; nsxCategory?: string } = { policyName: 'generated' }
const out = (id: string, rules: Rule[] = sampleRules(), o = opts) => TARGETS.find((t) => t.id === id)!.generate(rules, o)
const rule = (over: Partial<Rule>): Rule => ({ ...blankRule(), name: 'r1', ...over })

describe('MikroTik RouterOS', () => {
  const commands = (rules: Rule[], options = opts) => out('mikrotik', rules, options).split('\n').filter((line) => line.startsWith('/'))
  const errors = (rules: Rule[]) => validate(rules, 'mikrotik').filter((issue) => issue.level === 'error')
  const warnings = (rules: Rule[]) => validate(rules, 'mikrotik').filter((issue) => issue.level === 'warn').map((issue) => issue.message).join('\n')

  it.each([
    ['Auto', 'Inbound', 'input'], ['Auto', 'Outbound', 'output'],
    ['input', 'Outbound', 'input'], ['output', 'Inbound', 'output'], ['forward', 'Inbound', 'forward'], ['forward', 'Outbound', 'forward'],
  ] as const)('maps %s / %s to %s without changing addresses', (routerosChain, direction, effective) => {
    const rules = [rule({ routerosChain, direction, source: '10.0.0.1', destination: '10.0.0.2' })]
    expect(errors(rules)).toEqual([])
    expect(commands(rules)[0]).toContain(`chain=${effective}`)
    expect(commands(rules)[0]).toContain('src-address=10.0.0.1 dst-address=10.0.0.2')
  })

  it.each([['ALLOW', 'accept'], ['DROP', 'drop'], ['REJECT', 'reject']] as const)('preserves %s as %s', (action, native) => {
    const command = commands([rule({ action })])[0]
    expect(command).toContain(`action=${native}`)
    expect(command.includes('reject-with=icmp-admin-prohibited')).toBe(action === 'REJECT')
  })

  it.each(['TCP', 'UDP'] as const)('preserves %s ports, lists and ranges', (protocol) => {
    const command = commands([rule({ service: 'Custom', protocol, ports: '0, 53, 80-443, 65535' })])[0]
    expect(command).toContain(`protocol=${protocol.toLowerCase()} dst-port=0,53,80-443,65535`)
  })

  it.each(['ICMP', 'ANY'] as const)('emits %s without a port constraint', (protocol) => {
    const command = commands([rule({ service: 'Custom', protocol, ports: '' })])[0]
    expect(command).not.toContain('dst-port=')
    expect(command.includes('protocol=icmp')).toBe(protocol === 'ICMP')
    expect(command.includes('protocol=')).toBe(protocol !== 'ANY')
  })

  it('expands source × destination in list order and keeps each rule contiguous', () => {
    const rules = [rule({ name: 'first', source: ' 10.0.0.1, 10.0.0.2 ', destination: '192.0.2.1, 192.0.2.2' }), rule({ name: 'last' })]
    const lines = commands(rules)
    expect(lines).toHaveLength(5)
    expect(lines.slice(0, 4).map((line) => line.match(/src-address=(\S+) dst-address=(\S+)/)?.slice(1))).toEqual([
      ['10.0.0.1', '192.0.2.1'], ['10.0.0.1', '192.0.2.2'], ['10.0.0.2', '192.0.2.1'], ['10.0.0.2', '192.0.2.2'],
    ])
    expect(lines.slice(0, 4).every((line) => line.includes('comment="first"'))).toBe(true)
    expect(lines[4]).toContain('comment="last"')
    expect(commands([...rules].reverse())[0]).toContain('comment="last"')
  })

  it('expands RFC1918 and public DNS, omits Any and supports /0 and /32', () => {
    const lines = commands([rule({ source: 'Private networks (RFC1918)', destination: 'Public DNS (1.1.1.1, 8.8.8.8)' })])
    expect(lines).toHaveLength(6)
    expect(lines[0]).toContain('src-address=10.0.0.0/8 dst-address=1.1.1.1')
    expect(lines[5]).toContain('src-address=192.168.0.0/16 dst-address=8.8.8.8')
    expect(commands([rule({ source: 'Any', destination: '*' })])[0]).not.toMatch(/(?:src|dst)-address=/)
    expect(commands([rule({ source: '0.0.0.0/0', destination: '255.255.255.255/32' })])[0]).toContain('src-address=0.0.0.0/0 dst-address=255.255.255.255/32')
  })

  it('appends only filter adds, without implicit return traffic, NAT or default deny', () => {
    const lines = commands([rule({})])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\/ip firewall filter add /)
    expect(lines[0]).not.toMatch(/remove|reset|place-before|connection-state|fasttrack|jump|nat|priority=/)
    expect(warnings([rule({})])).toMatch(/no existing rules are removed or reordered/i)
    expect(warnings([])).toContain('Reimport creates duplicates')
    expect(warnings([])).toContain('accepts packets when no filter matches')
  })

  it('escapes names, notes, log prefixes, policy labels and control characters', () => {
    const name = 'r"\\$x; [/system reboot]\nnext\r\t\u0000'
    const notes = 'note "quoted" \\ $foo # comment\n/system reboot'
    const lines = commands([rule({ name, notes, logging: true })], { policyName: 'policy\n/system reboot\r\\$x' })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(String.raw`log=yes log-prefix="r\"\\\$x; [/system reboot]\nnext\r\t\00"`)
    expect(lines[0]).toContain(String.raw`comment="r\"\\\$x; [/system reboot]\nnext\r\t\00: note \"quoted\" \\ \$foo # comment\n/system reboot"`)
    expect(out('mikrotik', [rule({ name, notes, logging: true })], { policyName: 'policy\n/system reboot\r\\$x' })).toContain(String.raw`# Policy label: "policy\n/system reboot\r\\\$x"`)
    expect(commands([rule({ logging: false })])[0]).toContain('log=no')
    expect(commands([rule({ logging: false })])[0]).not.toContain('log-prefix=')
  })

  it('encodes non-ASCII control characters as uppercase UTF-8 byte escapes', () => {
    expect(commands([rule({ notes: '\u0007\u001b\u007f\u0085\u2028é' })])[0]).toContain(String.raw`comment="r1: \07\1B\7F\C2\85\E2\80\A8\C3\A9"`)
  })

  it.each([
    '', 'Internet', '2001:db8::1', 'example.com', 'group-name', '256.0.0.1', '1.2.3.4/33', '1.2.3.4/-1', '01.2.3.4',
    'Any,10.0.0.1', '*,10.0.0.1', '10.0.0.1,', ',10.0.0.1', '10.0.0.1,,10.0.0.2', '10.0.0.1,bad', 'bad,10.0.0.1', '10.0.0.1; /system reboot',
  ])('blocks every invalid source and destination: %s', (address) => {
    for (const field of ['source', 'destination']) {
      const rules = [rule({ name: 'valid' }), rule({ name: 'invalid', [field]: address })]
      expect(errors(rules).length).toBeGreaterThan(0)
      expect(commands(rules)).toEqual([])
      expect(out('mikrotik', rules)).toContain('# BLOCKED:')
    }
  })

  it.each(['65536', '443-80', '1-65536', '80,', ',80', '80,,443', '-1', 'abc', '1:2', '1 - 2', '80; /system reboot'])('blocks invalid ports: %s', (ports) => {
    const rules = [rule({ ports, service: 'Custom' })]
    expect(errors(rules).length).toBeGreaterThan(0)
    expect(commands(rules)).toEqual([])
  })

  it.each(['ICMP', 'ANY'] as const)('does not discard %s port constraints', (protocol) => {
    const rules = [rule({ protocol, ports: '80', service: 'Custom' })]
    expect(errors(rules).some((issue) => issue.message.includes('ports require TCP or UDP'))).toBe(true)
    expect(commands(rules)).toEqual([])
  })

  it.each([
    { routerosChain: 'custom' }, { routerosChain: '' }, { direction: 'Forward' }, { action: 'JUMP' }, { protocol: 'SCTP' }, { service: 'unknown' },
    { service: 'HTTPS (TCP 443)', ports: '80' }, { name: '' }, { program: 'app.exe' }, { scope: '/infra/groups/x' },
    { zone: 'public' }, { srcZone: 'trust' }, { dstZone: 'untrust' }, { profile: 'Private' }, { permanent: false },
  ])('blocks unsupported enabled rule options: %j', (overrides) => {
    const rules = [rule(overrides as Partial<Rule>)]
    expect(errors(rules).length).toBeGreaterThan(0)
    expect(commands(rules)).toEqual([])
  })

  it('ignores disabled errors but blocks duplicate enabled names', () => {
    const invalid = rule({ enabled: false, source: 'bad', routerosChain: 'invalid' as Rule['routerosChain'] })
    expect(errors([rule({}), invalid])).toEqual([])
    expect(commands([rule({}), invalid])).toHaveLength(1)
    expect(commands([invalid])).toEqual([])
    expect(commands([])).toEqual([])
    expect(errors([rule({}), rule({})])).toHaveLength(1)
    expect(commands([rule({}), rule({})])).toEqual([])
  })

  it('does not make blocked diagnostics executable even with injected newlines', () => {
    const text = out('mikrotik', [rule({ name: 'evil\n/system reboot\r:put "x"', source: 'bad\n/system reboot' })], { policyName: 'evil\n/system reboot' })
    expect(text.split('\n').filter(Boolean).every((line) => line.startsWith('#'))).toBe(true)
    expect(text).toContain(String.raw`evil\n/system reboot\r:put \"x\"`)
  })

  it('uses table ordering instead of RouterOS packet-priority matching', () => {
    const rules = [rule({ priority: '200' })]
    expect(errors(rules)).toEqual([])
    expect(warnings(rules)).toContain('priority matches packet priority')
    expect(commands(rules)[0]).not.toContain('priority=')
  })

  it('warns only when a true catch-all precedes another enabled rule in the same chain', () => {
    const drop = rule({ name: 'drop', action: 'DROP', service: 'Custom', protocol: 'ANY', ports: '', routerosChain: 'input' })
    expect(warnings([drop, rule({ routerosChain: 'output' })])).not.toContain('later rules in that chain')
    expect(warnings([drop, rule({ routerosChain: 'forward' })])).not.toContain('later rules in that chain')
    expect(warnings([drop, rule({})])).toContain('later rules in that chain never match')
    expect(warnings([{ ...drop, protocol: 'TCP' }, rule({})])).not.toContain('later rules in that chain')
    expect(warnings([drop, rule({ enabled: false })])).not.toContain('later rules in that chain')
    expect(warnings([{ ...drop, action: 'ALLOW' }, rule({})])).toContain('catch-all allow in input')
    expect(warnings([{ ...drop, source: '0.0.0.0/0', destination: '*', routerosChain: 'forward' }, rule({ routerosChain: 'forward' })])).toContain('catch-all drop in forward')
  })

  it.each(['Auto', 'input', 'forward', 'output'] as const)('roundtrips chain %s through CSV, JSON and share links', async (routerosChain) => {
    const original = rule({ routerosChain, direction: 'Outbound', notes: 'chain note', logging: true })
    const { id: _id, ...expected } = original
    expect(parseCsv(toCsv([original], EXTRA_COLUMNS.mikrotik))[0]).toMatchObject(expected)
    expect(parseJson(toJson([original], { target: 'mikrotik', policyName: 'policy' })).rules[0]).toMatchObject(expected)
    const decoded = await decodeState(await encodeState({ rules: [original], target: 'mikrotik', policyName: 'policy' }))
    expect(decoded?.target).toBe('mikrotik')
    expect(decoded?.rules[0]).toMatchObject(expected)
  })

  it('defaults old CSV/JSON rules and share links to Auto without changing Direction', async () => {
    const { routerosChain: _chain, ...old } = rule({ direction: 'Outbound' })
    expect(parseCsv('name,source,destination,service,ports,action,direction\nold,Any,Any,TCP,443,ALLOW,Outbound')[0]).toMatchObject({ routerosChain: 'Auto', direction: 'Outbound' })
    expect(parseJson(JSON.stringify([old])).rules[0]).toMatchObject({ routerosChain: 'Auto', direction: 'Outbound' })
    const decoded = await decodeState(await encodeState({ rules: [old as Rule], target: 'mikrotik', policyName: 'old' }))
    expect(decoded?.rules[0]).toMatchObject({ routerosChain: 'Auto', direction: 'Outbound' })
    expect(commands([old as Rule])[0]).toContain('chain=output')
  })

  it.each([
    ['action', 'JUMP'], ['direction', 'Forward'], ['protocol', 'SCTP'], ['source', null], ['ports', 443], ['logging', 'yes'], ['profile', 'unknown'],
  ])('rejects invalid JSON %s instead of substituting a RouterOS default', (field, value) => {
    const rules = [{ ...rule({}), [field]: value }]
    expect(parseJson(JSON.stringify(rules), 'mikrotik')).toMatchObject({ rules: [], error: expect.stringContaining(`invalid ${field}`) })
    expect(parseJson(JSON.stringify({ target: 'mikrotik', rules })).error).toContain(`invalid ${field}`)
  })

  it.each([
    ['source', ''], ['action', 'JUMP'], ['direction', 'Forward'], ['service', 'SCTP'], ['profile', 'unknown'], ['ports', '22'],
  ])('blocks invalid or conflicting CSV %s without changing its meaning', (field, value) => {
    const fields = ['name', 'source', 'destination', 'service', 'ports', 'action', 'direction', 'profile']
    const cells = ['imported', 'Any', 'Any', 'HTTPS (TCP 443)', '', 'ALLOW', 'Inbound', 'Any']
    cells[fields.indexOf(field)] = value
    const imported = parseCsv(`${fields.join(',')}\n${cells.join(',')}`, EXTRA_COLUMNS.mikrotik)
    expect(commands(imported)).toEqual([])
  })

  it('does not silently turn invalid imported chains into Auto', () => {
    expect(parseJson(JSON.stringify([rule({ routerosChain: 'custom' as Rule['routerosChain'] })]))).toMatchObject({ rules: [], error: expect.stringContaining('Invalid RouterOS chain') })
    expect(parseJson(JSON.stringify([{ routerosChain: null }])).error).toContain('Invalid RouterOS chain')
    const csv = 'name,source,destination,service,ports,routerosChain\nr1,Any,Any,TCP,443,custom'
    expect(commands(parseCsv(csv))).toEqual([])
    expect(parseCsv(csv.replace('custom', 'FORWARD'))[0].routerosChain).toBe('forward')
  })
})

describe('MikroTik Terraform', () => {
  const resources = (text: string) => [...text.matchAll(/resource "routeros_ip_firewall_filter" "([^"]+)" \{\n([\s\S]*?)\n\}/g)]

  it('uses the configured community provider and secure external credentials', () => {
    const text = out('mikrotik-tf')
    expect(text).toContain(requiredProviders('routeros'))
    expect(text).toContain('source  = "terraform-routeros/routeros"')
    expect(text).toContain('insecure = false')
    expect(text).toContain('password = var.routeros_password')
    expect(text).toContain('sensitive = true')
    expect(text).toContain('can(regex("^https://", var.routeros_hosturl))')
    expect(text).not.toMatch(/local-exec|remote-exec|\/ip firewall filter add|place_before|connection_state|priority\s*=/)
    expect(validate([], 'mikrotik-tf').map((issue) => issue.message).join('\n')).toContain('apply/destroy can update/delete')
    expect(text).not.toContain('Reimport creates duplicates')
  })

  it.each([
    ['Auto', 'Inbound', 'input'], ['Auto', 'Outbound', 'output'], ['forward', 'Outbound', 'forward'], ['input', 'Outbound', 'input'],
  ] as const)('preserves %s / %s as chain %s', (routerosChain, direction, chain) => {
    expect(out('mikrotik-tf', [rule({ routerosChain, direction })])).toMatch(new RegExp(`chain\\s*= "${chain}"`))
  })

  it.each([['ALLOW', 'accept'], ['DROP', 'drop'], ['REJECT', 'reject']] as const)('preserves %s and explicit rejection behavior', (action, native) => {
    const text = out('mikrotik-tf', [rule({ action, logging: true, notes: 'note' })])
    expect(text).toMatch(new RegExp(`action\\s*= "${native}"`))
    expect(text.includes('reject_with')).toBe(action === 'REJECT')
    if (action === 'REJECT') expect(text).toContain('"icmp-admin-prohibited"')
    expect(text).toMatch(/log\s*= true/)
    expect(text).toMatch(/log_prefix\s*= "r1"/)
    expect(text).toMatch(/comment\s*= "r1: note"/)
  })

  it('preserves Cartesian expansions, port ranges and creation/managed order', () => {
    const text = out('mikrotik-tf', [rule({ source: 'Private networks (RFC1918)', destination: 'Public DNS (1.1.1.1, 8.8.8.8)', service: 'Custom', protocol: 'UDP', ports: '53, 100-200' })])
    const blocks = resources(text)
    expect(blocks).toHaveLength(6)
    expect(blocks[0][2]).toMatch(/src_address\s*= "10.0.0.0\/8"/)
    expect(blocks[5][2]).toMatch(/dst_address\s*= "8.8.8.8"/)
    blocks.forEach((block, index) => {
      expect(block[2]).toMatch(/dst_port\s*= "53,100-200"/)
      expect(block[2]).toMatch(/disabled\s*= false/)
      if (index) expect(block[2]).toContain(`depends_on  = [routeros_ip_firewall_filter.${blocks[index - 1][1]}]`)
    })
    const order = text.split('resource "routeros_move_items"')[1]
    expect(order).toContain('resource_path = "/ip/firewall/filter"')
    expect([...order.matchAll(/routeros_ip_firewall_filter\.([\w]+)\.id/g)].map((match) => match[1])).toEqual(blocks.map((block) => block[1]))
  })

  it('keeps collision-free resource names stable across reordering', () => {
    const rules = [rule({ name: 'a-b' }), rule({ name: 'a_b' }), rule({ name: 'é' }), rule({ name: '😀' })]
    const first = resources(out('mikrotik-tf', rules)).map((block) => block[1])
        expect(new Set(first).size).toBe(rules.length)
    expect(resources(out('mikrotik-tf', [...rules].reverse())).map((block) => block[1])).toEqual([...first].reverse())
  })

  it.each(['ICMP', 'ANY'] as const)('omits ports and wildcard addresses for %s', (protocol) => {
    const text = resources(out('mikrotik-tf', [rule({ service: 'Custom', protocol, ports: '' })]))[0][2]
    expect(text).not.toMatch(/dst_port|src_address|dst_address/)
    expect(text.includes('protocol')).toBe(protocol !== 'ANY')
  })

  it('escapes HCL template directives, quotes, newlines and Unicode', () => {
    const text = out('mikrotik-tf', [rule({ name: 'r${secret}', notes: '"\\\n%{if true} café', logging: true })], { policyName: '${policy}' })
    expect(text).toContain('$${secret}')
    expect(text).toContain('%%{if true}')
    expect(text).toContain('café')
    expect(text).toContain('\\n')
    expect(text).toContain('$${policy}')
    expect(resources(text)).toHaveLength(1)
  })

  it('rejects unsafe rules with a version guard instead of a destructive empty configuration', () => {
    for (const invalid of [rule({ source: 'Internet' }), rule({ ports: '443,', service: 'Custom' }), rule({ scope: '/group' }), rule({ permanent: false })]) {
      const text = out('mikrotik-tf', [rule({ name: 'valid' }), invalid])
      expect(text).toContain('# BLOCKED:')
      expect(text).toContain('required_version = "< 0.0.0"')
      expect(text).not.toContain('resource "')
      expect(validate([invalid], 'mikrotik-tf').some((issue) => issue.level === 'error')).toBe(true)
    }
  })

  it('omits disabled rules and avoids invalid zero/single-item moves', () => {
    for (const rules of [[], [rule({})], [rule({}), rule({ name: 'disabled', enabled: false, source: 'bad' })]])
      expect(out('mikrotik-tf', rules)).not.toContain('routeros_move_items')
    expect(resources(out('mikrotik-tf', [rule({ enabled: false, source: 'bad' })]))).toHaveLength(0)
  })

  it('preserves Terraform format and chain across serialization and rejects invalid JSON', async () => {
    const original = rule({ routerosChain: 'forward' })
    expect(parseCsv(toCsv([original], EXTRA_COLUMNS['mikrotik-tf']), EXTRA_COLUMNS['mikrotik-tf'])[0]).toMatchObject({ routerosChain: 'forward' })
    expect(parseJson(toJson([original], { target: 'mikrotik-tf', policyName: 'tf' })).rules[0]).toMatchObject({ routerosChain: 'forward' })
    expect((await decodeState(await encodeState({ rules: [original], target: 'mikrotik-tf', policyName: 'tf' })))?.target).toBe('mikrotik-tf')
    expect(parseJson('[{"action":"JUMP"}]', 'mikrotik-tf').error).toContain('invalid action')
  })
})

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
    expect(text).toContain("argv: ['firewall-cmd', '--permanent', '--policy', 'generated-out', '--query-ingress-zone', 'HOST']")
    expect(text).toContain("argv: ['firewall-cmd', '--permanent', '--policy', 'generated-out', '--query-egress-zone', 'ANY']")
    expect(text).toContain("argv: ['firewall-cmd', '--permanent', '--policy', 'generated-out', '--query-rich-rule'")
    expect(text).toContain("argv: ['firewall-cmd', '--permanent', '--policy', 'generated-out', '--add-rich-rule'")
    expect(text).toContain('failed_when: firewalld_check_0.rc not in [0, 1]')
    expect(text).toContain('when: firewalld_check_2.rc == 1')
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

  it('nsx category defaults to Application and is honoured by Terraform, REST and SDK output', () => {
    const rules = [rule({ name: 'a', source: '10.0.0.0/8', destination: '10.1.1.1' })]
    for (const id of ['nsx', 'nsx-ps', 'nsx-sdk']) expect(out(id, rules)).toMatch(/Application/)
    const env = { policyName: 'generated', nsxCategory: 'Environment' }
    expect(out('nsx', rules, env)).toContain('category     = "Environment"')
    expect(out('nsx-ps', rules, env)).toContain('"category": "Environment"')
    expect(out('nsx-sdk', rules, env)).toContain("-Category 'Environment'")
    expect(out('nsx', rules, env)).not.toContain('Application')
  })

  it('offers only IP-rule NSX categories and falls back to Application for anything else', () => {
    expect([...NSX_CATEGORIES]).toEqual(['Emergency', 'Infrastructure', 'Environment', 'Application'])
    expect(normalizeNsxCategory('Ethernet')).toBe('Application')
    expect(normalizeNsxCategory('Emergency')).toBe('Emergency')
    expect(normalizeNsxCategory(undefined)).toBe('Application')
    expect(normalizeNsxCategory('')).toBe('Application')
  })
  it('nsx project is optional and switches Terraform, REST and SDK output to project scope', () => {
    const rules = [rule({ name: 'a', source: '10.0.0.0/8', destination: '10.1.1.1' })]
    const withProject = { policyName: 'generated', nsxProject: 'proj-1' }
    const tf = out('nsx', rules, withProject)
    expect(tf).toContain('data "nsxt_policy_project" "project"')
    expect(tf).toContain('id = "proj-1"')
    expect(tf).toContain('project_id = data.nsxt_policy_project.project.id')
    expect(out('nsx', rules)).not.toContain('nsxt_policy_project')
    expect(out('nsx-ps', rules, withProject)).toContain('/policy/api/v1/orgs/default/projects/proj-1/infra/domains/default/security-policies/')
    expect(out('nsx-ps', rules)).toContain('/policy/api/v1/infra/domains/default/')
    expect(out('nsx-sdk', rules, withProject)).toContain("Invoke-OrgsOrgIdProjectsProjectIdInfraPatchSecurityPolicyForDomain -OrgId 'default' -ProjectId 'proj-1' -DomainId 'default'")
    expect(out('nsx-sdk', rules)).toContain("Invoke-PatchSecurityPolicyForDomain -DomainId 'default'")
  })

  it('every Terraform target declares required_providers from providers.json', () => {
    for (const id of ['nsx', 'azfw-tf', 'fmc', 'cisco-tf', 'panos', 'panos-1x']) {
      expect(out(id), id).toMatch(/required_providers \{[\s\S]*version = "~> \d+\.\d+"/)
    }
    for (const [key, p] of Object.entries(providers)) {
      expect(p.version.startsWith(`${p.major}.`), key).toBe(true)
      expect(requiredProviders(key as keyof typeof providers)).toContain(`source  = "${p.source}"`)
    }
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
