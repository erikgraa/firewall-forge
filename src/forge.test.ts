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
import { createTemplateRules } from './templates'
import { supportsDisabledRules } from './disabledRules'
import { generateGroupedOutput } from './groupedOutput'

const opts: { policyName: string; nsxProject?: string; nsxCategory?: string } = { policyName: 'generated' }
const out = (id: string, rules: Rule[] = sampleRules(), o = opts) => TARGETS.find((t) => t.id === id)!.generate(rules, o)
const rule = (over: Partial<Rule>): Rule => ({ ...blankRule(), name: 'r1', ...over })

describe('starter template output', () => {
  it.each(TARGETS)('keeps starter rules valid for $id without modifying the saved policy', (target) => {
    const existing = [rule({ name: 'existing', source: '10.0.0.1', destination: '10.0.0.2' })]
    const before = JSON.stringify(existing)
    const options = target.id
    const starters = [
      ...createTemplateRules('ssh', options, existing),
      ...createTemplateRules('web', options, existing),
      ...createTemplateRules('dns', options, existing),
    ]
    expect(starters).toHaveLength(4)
    expect(starters.every((starter) => !starter.enabled && starter.source === 'Any' && starter.destination === 'Any')).toBe(true)
    expect(validate([...existing, ...starters], target.id).filter((issue) => issue.level === 'error')).toEqual([])
    expect(JSON.stringify(existing)).toBe(before)
    expect(target.generate(starters, opts)).not.toContain('BLOCKED:')
  })

  it.each(['ssh', 'web', 'dns'] as const)('keeps %s starters disabled through CSV, JSON and share-link round trips', async (template) => {
    const rules = createTemplateRules(template, 'mikrotik')
    const expected = rules.map(({ name, service, protocol, ports, source, destination, enabled, routerosChain }) => ({ name, service, protocol, ports, source, destination, enabled, routerosChain }))
    expect(parseCsv(toCsv(rules, EXTRA_COLUMNS.mikrotik), EXTRA_COLUMNS.mikrotik)).toMatchObject(expected)
    expect(parseJson(toJson(rules, { target: 'mikrotik', policyName: 'starters' })).rules).toMatchObject(expected)
    expect((await decodeState(await encodeState({ rules, target: 'mikrotik', policyName: 'starters' })))?.rules).toMatchObject(expected)
  })

  it('emits both DNS protocols and the selected RouterOS chain in recipe order', () => {
    const starters = createTemplateRules('dns', 'mikrotik')
    expect(out('mikrotik', starters).match(/disabled=yes/g)).toHaveLength(2)
    expect(out('mikrotik-tf', starters).match(/disabled\s*= true/g)).toHaveLength(2)
    const rules = starters.map((starter) => ({ ...starter, source: '10.20.0.0/24', destination: '10.30.0.10', enabled: true }))
    const commands = out('mikrotik', rules).split('\n').filter((line) => line.startsWith('/ip firewall filter add'))
    expect(commands).toHaveLength(2)
    expect(commands[0]).toContain('protocol=udp dst-port=53')
    expect(commands[1]).toContain('protocol=tcp dst-port=53')
    expect(commands.every((line) => line.includes('chain=forward') && line.includes('src-address=10.20.0.0/24 dst-address=10.30.0.10'))).toBe(true)
    expect(out('mikrotik-tf', rules)).not.toContain('BLOCKED:')
  })

  it('uses native NSX service references rather than unresolved custom-service placeholders', () => {
    const starters = [...createTemplateRules('ssh', 'nsx'), ...createTemplateRules('web', 'nsx'), ...createTemplateRules('dns', 'nsx')]
    expect(out('nsx', starters).match(/disabled\s*= true/g)).toHaveLength(4)
    for (const service of ['SSH', 'HTTPS', 'DNS-UDP', 'DNS']) expect(out('nsx', starters)).toContain(`services           = ["/infra/services/${service}"]`)
    const rules = starters.map((starter) => ({ ...starter, source: '10.20.0.0/24', destination: '10.30.0.10', enabled: true }))
    const code = out('nsx', rules)
    for (const service of ['SSH', 'HTTPS', 'DNS-UDP', 'DNS']) expect(code).toContain(`services           = ["/infra/services/${service}"]`)
    expect(code).not.toContain('TODO:')
    expect(code.match(/source_groups\s*= \["10.20.0.0\/24"\]/g)).toHaveLength(4)
    expect(code.match(/destination_groups\s*= \["10.30.0.10"\]/g)).toHaveLength(4)
  })

  it('keeps Windows DNS commands scoped to the configured clients and server', () => {
    const starters = createTemplateRules('dns', 'windows')
    expect(out('windows', starters).match(/-Enabled False/g)).toHaveLength(2)
    expect(out('windows', starters)).not.toContain('-Enabled $false')
    const rules = starters.map((starter) => ({ ...starter, source: '10.20.0.0/24', destination: '10.30.0.10', enabled: true }))
    const code = out('windows', rules)
    expect(code.match(/New-NetFirewallRule/g)).toHaveLength(2)
    expect(code).toContain('-Protocol UDP')
    expect(code).toContain('-Protocol TCP')
    expect(code).toContain("-RemoteAddress '10.20.0.0/24'")
    expect(code).toContain("-LocalAddress '10.30.0.10'")
    expect(code).toContain("-LocalPort '53'")
  })
})

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

  it('validates retained disabled rules and blocks duplicate names in either state', () => {
    const invalid = rule({ name: 'invalid', enabled: false, source: 'bad', routerosChain: 'invalid' as Rule['routerosChain'] })
    expect(errors([rule({}), invalid]).length).toBeGreaterThan(0)
    expect(commands([rule({}), invalid])).toEqual([])
    expect(commands([invalid])).toEqual([])
    expect(commands([])).toEqual([])
    expect(errors([rule({}), rule({})])).toHaveLength(1)
    expect(errors([rule({}), rule({ enabled: false })])).toHaveLength(1)
    expect(commands([rule({}), rule({ enabled: false })])).toEqual([])
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

  it('retains valid disabled rules and avoids invalid zero/single-item moves', () => {
    for (const rules of [[], [rule({})], [rule({ enabled: false })]])
      expect(out('mikrotik-tf', rules)).not.toContain('routeros_move_items')
    const mixed = out('mikrotik-tf', [rule({}), rule({ name: 'disabled', enabled: false })])
    expect(resources(mixed)).toHaveLength(2)
    expect(mixed).toContain('routeros_move_items')
    const invalid = out('mikrotik-tf', [rule({ enabled: false, source: 'bad' })])
    expect(resources(invalid)).toHaveLength(0)
    expect(invalid).toContain('required_version = "< 0.0.0"')
  })

  it('preserves Terraform format and chain across serialization and rejects invalid JSON', async () => {
    const original = rule({ routerosChain: 'forward' })
    expect(parseCsv(toCsv([original], EXTRA_COLUMNS['mikrotik-tf']), EXTRA_COLUMNS['mikrotik-tf'])[0]).toMatchObject({ routerosChain: 'forward' })
    expect(parseJson(toJson([original], { target: 'mikrotik-tf', policyName: 'tf' })).rules[0]).toMatchObject({ routerosChain: 'forward' })
    expect((await decodeState(await encodeState({ rules: [original], target: 'mikrotik-tf', policyName: 'tf' })))?.target).toBe('mikrotik-tf')
    expect(parseJson('[{"action":"JUMP"}]', 'mikrotik-tf').error).toContain('invalid action')
  })
})

describe('native disabled-rule output', () => {
  const formats = [
    { id: 'nsx', off: /disabled\s*= true/g, on: /disabled\s*= false/g },
    { id: 'nsx-ps', off: /"disabled": true/g, on: /"disabled": false/g },
    { id: 'nsx-sdk', off: /-Disabled \$true/g, on: /-Disabled \$false/g },
    { id: 'windows', off: /-Enabled False/g, on: /-Enabled True/g },
    { id: 'fmc', off: /enabled = false/g, on: /enabled = true/g },
    { id: 'panos', off: /disabled\s*= true/g, on: /disabled\s*= false/g },
    { id: 'panos-1x', off: /disabled\s*= true/g, on: /disabled\s*= false/g },
    { id: 'panos-ansible', off: /disabled: true/g, on: /disabled: false/g },
    { id: 'mikrotik', off: /disabled=yes/g, on: /disabled=no/g },
    { id: 'mikrotik-tf', off: /disabled\s*= true/g, on: /disabled\s*= false/g },
  ] as const

  it.each(formats)('$id retains mixed rule states and their original order', ({ id, off, on }) => {
    const rules = [rule({ name: 'first-rule' }), rule({ name: 'middle-rule', enabled: false }), rule({ name: 'last-rule' })]
    const before = JSON.stringify(rules)
    const code = out(id, rules)
    expect(code.match(off)).toHaveLength(1)
    expect(code.match(on)).toHaveLength(2)
    expect(code.indexOf('first-rule')).toBeLessThan(code.indexOf('middle-rule'))
    expect(code.indexOf('middle-rule')).toBeLessThan(code.indexOf('last-rule'))
    expect(JSON.stringify(rules)).toBe(before)
  })

  it.each(formats)('$id changes only the native state when a narrow rule is toggled', ({ id, off, on }) => {
    const rules = [rule({ name: 'keep-identity', enabled: false })]
    const disabled = out(id, rules)
    const enabled = out(id, [{ ...rules[0], enabled: true }])
    expect(disabled.replace(off, '<state>')).toBe(enabled.replace(on, '<state>'))
    expect(disabled).not.toMatch(/count\s*=\s*0|state:\s*absent/)
  })

  it.each(formats)('$id blocks invalid retained disabled rules without emitting a partial policy', ({ id }) => {
    const rules = [rule({ name: 'valid-rule' }), rule({ name: 'invalid-rule', enabled: false, ports: '70000' })]
    const code = out(id, rules)
    expect(code).toContain('BLOCKED:')
    expect(code).not.toMatch(/New-NetFirewallRule|Initialize-Rule|\/ip firewall filter add|resource "/)
    const grouped = generateGroupedOutput(rules, id, opts, [], {}, false)
    expect(grouped.blocked).toBe(true)
    expect(grouped.code).toBe(code)
    if (['nsx', 'fmc', 'panos', 'panos-1x', 'mikrotik-tf'].includes(id)) expect(code).toContain('required_version = "< 0.0.0"')
  })

  it.each(['panos', 'panos-1x', 'panos-ansible'] as const)('%s retains service dependencies for disabled rules', (id) => {
    const code = out(id, [rule({ enabled: false, ports: '2222', service: 'Custom' })])
    expect(code).toContain('tcp-2222')
    expect(code).toContain(id === 'panos-ansible' ? 'paloaltonetworks.panos.panos_service_object:' : id === 'panos-1x' ? 'resource "panos_service_object"' : 'resource "panos_service"')
  })

  it('keeps RouterOS address expansions disabled and in the managed move sequence', () => {
    const rules = [rule({ name: 'expanded', enabled: false, source: 'Private networks (RFC1918)', destination: '10.0.0.1,10.0.0.2' }), rule({ name: 'last-rule' })]
    const code = out('mikrotik-tf', rules)
    expect(code.match(/disabled\s*= true/g)).toHaveLength(6)
    expect(code.match(/disabled\s*= false/g)).toHaveLength(1)
    const refs = [...code.matchAll(/resource "routeros_ip_firewall_filter" "([^"]+)"/g)].map((match) => match[1])
    const move = code.slice(code.indexOf('resource "routeros_move_items"'))
    expect(refs).toHaveLength(7)
    expect([...move.matchAll(/routeros_ip_firewall_filter\.([^.]+)\.id/g)].map((match) => match[1])).toEqual(refs)
    const native = out('mikrotik', rules).split('\n').filter((line) => line.startsWith('/ip firewall filter add'))
    expect(native).toHaveLength(7)
    expect(native.slice(0, 6).every((line) => line.includes('disabled=yes'))).toBe(true)
    expect(native[6]).toContain('disabled=no')
  })

  it.each(TARGETS.filter((target) => !supportsDisabledRules(target.id)))('$id keeps omission warnings and follows its all-disabled output convention', (target) => {
    const rules = [rule({ name: 'inactive-test-rule', enabled: false }), rule({ name: 'inactive-second', enabled: false })]
    const output = generateGroupedOutput(rules, target.id, opts, [], {}, false)
    expect(output.blocked).toBe(false)
    expect(output.warnings).toHaveLength(1)
    expect(output.warnings[0]).toContain('2 disabled rules omitted')
    expect(output.warnings[0]).toContain('does not disable an existing deployed rule')
    expect(output.warnings[0]).toContain('may remove previously managed rules')
    const prefix = target.filename.endsWith('.bicep') ? '//' : target.id === 'cisco' ? '!' : '#'
    if (target.format === 'Ansible') expect(output.code).toBe('')
    else expect(output.code).toContain(`${prefix} WARNING: ${output.warnings[0]}`)
    expect(output.code).not.toContain('inactive-test-rule')
    expect(output.code).not.toContain('inactive-second')
    const enabled = out(target.id, [{ ...rules[0], enabled: true }])
    expect(enabled).not.toContain('disabled rule omitted')
    if (enabled.startsWith('#!')) expect(output.code.split('\n')[0]).toBe(enabled.split('\n')[0])
  })

  describe.each(TARGETS.filter((target) => target.format === 'Ansible' && !supportsDisabledRules(target.id)))('$id unsupported disabled-rule output', (target) => {
    it.each([1, 2])('returns truly empty output for %i disabled rules while retaining the UI warning', (count) => {
      const rules = Array.from({ length: count }, (_, index) => rule({ name: `inactive-${index}`, enabled: false, direction: 'Outbound' }))
      const before = JSON.stringify(rules)
      expect(out(target.id, rules)).toBe('')
      const output = generateGroupedOutput(rules, target.id, opts, [], {}, false)
      expect(output.code).toBe('')
      expect(output.blocked).toBe(false)
      expect(output.warnings).toHaveLength(1)
      expect(output.warnings[0]).toContain(`${count} disabled rule${count === 1 ? '' : 's'} omitted`)
      expect(output.warnings[0]).toContain('Omission does not disable an existing deployed rule')
      expect(JSON.stringify(rules)).toBe(before)
    })

    it('preserves the warning and enabled configuration for mixed inputs', () => {
      const rules = [rule({ name: 'inactive-first', enabled: false }), rule({ name: 'active-middle' }), rule({ name: 'inactive-last', enabled: false })]
      const output = generateGroupedOutput(rules, target.id, opts, [], {}, false)
      expect(output.code).toContain('# WARNING: 2 disabled rules omitted:')
      expect(output.code).toContain('active-middle')
      expect(output.code).not.toContain('inactive-first')
      expect(output.code).not.toContain('inactive-last')
      expect(output.code.slice(output.code.indexOf('\n') + 1)).toBe(out(target.id, [rules[1]]))
      expect(output.warnings[0]).toContain('Omission does not disable an existing deployed rule')
    })
  })

  it('does not treat disabled allows or denies as active evaluation rules', () => {
    const disabled = rule({ name: 'inactive', enabled: false, action: 'DROP', protocol: 'ANY', ports: '' })
    const enabled = rule({ name: 'active', action: 'ALLOW' })
    for (const id of ['windows', 'nsx', 'mikrotik'] as const) {
      const warnings = validate([disabled, enabled], id).filter((issue) => issue.level === 'warn').map((issue) => issue.message).join('\n')
      expect(warnings).not.toMatch(/later (enabled )?rules|block can override|allow any → any/)
      const trailing = validate([{ ...disabled, enabled: true }, { ...enabled, enabled: false }], id).map((issue) => issue.message).join('\n')
      expect(trailing).not.toMatch(/later (enabled )?rules|block can override/)
    }
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
  it('retains disabled rules only when the output has a real native disabled state', () => {
    const rules = [rule({ name: 'on' }), rule({ name: 'off', enabled: false })]
    for (const t of TARGETS) {
      const text = out(t.id, rules)
      expect(text).toContain('on')
      if (supportsDisabledRules(t.id)) expect(text).toMatch(/["']off["']/)
      else {
        expect(text).not.toMatch(/["']off["']/)
        expect(text).toContain('1 disabled rule omitted')
      }
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

  it.each(['azfw-ps', 'azfw-cli'])('%s preserves action runs, addresses, services and disabled omission without mutations', (id) => {
    const rules = [
      rule({ name: 'first', source: '10.0.0.0/8', destination: '10.1.1.1', service: 'Custom', ports: '80,5985-5986', notes: 'review $variables and "quotes" safely' }),
      rule({ name: 'second', source: '*', destination: '*', protocol: 'UDP', ports: '53' }),
      rule({ name: 'fqdn', destination: '1.login.microsoftonline.com,xn--bcher-kva.xn--p1ai' }),
      rule({ name: 'disabled', enabled: false, action: 'REJECT', source: 'corp' }),
      rule({ name: 'deny', action: 'DROP', source: '10.0.0.0/8', destination: '10.2.2.2' }),
      rule({ name: 'last', source: '10.0.0.0/8', destination: '10.3.3.3' }),
    ]
    const before = JSON.stringify(rules)
    const text = out(id, rules)
    expect(text).not.toContain('BLOCKED:')
    const start = id === 'azfw-ps' ? "@'\n" : "<<'FIREWALL_FORGE_JSON'\n"
    const end = id === 'azfw-ps' ? "\n'@" : '\nFIREWALL_FORGE_JSON'
    const payload = JSON.parse(text.slice(text.indexOf(start) + start.length, text.indexOf(end)))
    const collections = payload.properties.ruleCollections
    expect(collections.map((collection: { action: { type: string }; priority: number; name: string }) => [collection.action.type, collection.priority, collection.name])).toEqual([
      ['Allow', 1000, 'generated-1-allow'], ['Deny', 1100, 'generated-2-deny'], ['Allow', 1200, 'generated-3-allow'],
    ])
    expect(collections[0].rules.map((r: { name: string }) => r.name)).toEqual(['first', 'second', 'fqdn'])
    expect(collections[0].rules[0]).toMatchObject({ sourceAddresses: ['10.0.0.0/8'], destinationAddresses: ['10.1.1.1'], destinationPorts: ['80', '5985-5986'], description: rules[0].notes })
    expect(collections[0].rules[2]).toMatchObject({ sourceAddresses: ['*'], destinationFqdns: ['1.login.microsoftonline.com', 'xn--bcher-kva.xn--p1ai'] })
    expect(collections[0].rules[2]).not.toHaveProperty('destinationAddresses')
    expect(collections[0].rules[1]).toMatchObject({ sourceAddresses: ['*'], destinationAddresses: ['*'], ipProtocols: ['UDP'], destinationPorts: ['53'] })
    expect(text).toContain('disabled rule omitted')
    expect(JSON.stringify(rules)).toBe(before)
    expect(validate(rules.filter((r) => r.enabled), id as 'azfw-ps' | 'azfw-cli').filter((issue) => issue.level === 'error')).toEqual([])
  })

  it.each(['azfw-ps', 'azfw-cli'])('%s blocks unsupported mappings before emitting commands', (id) => {
    for (const over of [
      { action: 'REJECT' as const }, { source: 'corp' }, { source: 'host.example.com', destination: 'host.example.com' },
      { destination: '10.0.0.1,example.com' }, { destination: '*.example.com' }, { destination: '10.0.0.1/33' }, { source: '999.0.0.1' }, { source: '2001:db8::1' },
      { logging: true }, { priority: '100' }, { program: 'app.exe' }, { scope: '/infra/group' }, { zone: 'public' },
      { permanent: false }, { profile: 'Domain' as const }, { notes: 'x'.repeat(501) }, { name: 'bad\nname' },
      { protocol: 'ANY' as const, ports: '443' }, { protocol: 'ICMP' as const, ports: '80' },
      { destination: 'example.com', protocol: 'ICMP' as const, ports: '' }, { ports: '0' }, { ports: '443-80' },
    ]) {
      const rules = [rule({ source: '10.0.0.1', destination: '10.0.0.2', ...over })]
      expect(validate(rules, id as 'azfw-ps' | 'azfw-cli').some((issue) => issue.level === 'error')).toBe(true)
      const text = out(id, rules)
      expect(text).toContain('BLOCKED:')
      expect(text).not.toContain('New-AzFirewallPolicy')
      expect(text).not.toContain('az rest --method put')
    }
  })

  it('Azure scripts have explicit review/apply boundaries and DNS checks, with no policy provisioning', () => {
    const rules = [rule({ destination: 'example.com' })]
    const ps = out('azfw-ps', rules)
    expect(ps.indexOf('if (-not $Apply)')).toBeLessThan(ps.indexOf('Get-AzContext'))
    expect(ps).toContain('SupportsShouldProcess')
    expect(ps).toContain('$policy.DnsSettings.EnableProxy')
    expect(ps).toContain('-DefaultProfile $context -Confirm:$false')
    expect(ps).not.toContain('New-AzFirewallPolicy -')
    const cli = out('azfw-cli', rules)
    expect(cli.indexOf("if [[ ${1:-} != '--apply' ]]")).toBeLessThan(cli.indexOf('dns_proxy=$(az rest'))
    expect(cli).toContain('properties.dnsSettings.enableProxy')
    expect(cli).toContain('api-version=2024-05-01')
    expect(cli).toContain('--body "@$body_file"')
    expect(cli).toContain('trap')
    for (const id of ['azfw-ps', 'azfw-cli']) {
      expect(out(id, [])).not.toContain('az rest --method put')
      expect(out(id, [rule({ enabled: false })])).toContain('no create/update operation')
      expect(out(id, [rule({ protocol: 'ANY', ports: '' })])).toContain('"Any"')
    }
  })

  it('Azure CLI safely encodes multiline descriptions while Az.Network apostrophe limitations are explicit', () => {
    const notes = "  it's $() `quoted`\n'@\nFIREWALL_FORGE_JSON\n\"double quotes\"  "
    const rules = [rule({ notes })]
    const text = out('azfw-cli', rules)
    expect(text).not.toContain('BLOCKED:')
    const start = "<<'FIREWALL_FORGE_JSON'\n"
    const json = text.slice(text.indexOf(start) + start.length, text.indexOf('\nFIREWALL_FORGE_JSON'))
    expect(JSON.parse(json).properties.ruleCollections[0].rules[0].description).toBe(notes)
    expect(out('azfw-ps', rules)).toContain('serialization replaces apostrophes')
    expect(out('azfw-ps', [rule({ notes: 'safe\n"quoted" $()' })])).not.toContain('BLOCKED:')
  })

  it('Azure collection names are bounded and unique across all four formats', () => {
    const rules = [rule({ name: 'allow' }), rule({ name: 'deny', action: 'DROP' })]
    for (const id of ['azfw-tf', 'azfw-bicep', 'azfw-ps', 'azfw-cli']) {
      const text = out(id, rules, { policyName: 'Long-policy-'.repeat(20) })
      expect(text).not.toMatch(/name\s*=\s*["']--["']/)
      expect(text).toContain('-1-allow')
      expect(text).toContain('-2-deny')
    }
    const excessive = Array.from({ length: 642 }, (_, i) => rule({ name: `r${i}`, action: i % 2 ? 'DROP' : 'ALLOW' }))
    expect(out('azfw-cli', excessive)).toContain('priorities would exceed')
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
  it.each(TARGETS)('preserves mixed enabled states and old positional options for $id', (target) => {
    const extras = EXTRA_COLUMNS[target.id]
    const rules = [rule({ name: 'active', enabled: true }), rule({ name: 'inactive', enabled: false })]
    expect(parseCsv(toCsv(rules, extras), extras).map(({ name, enabled }) => ({ name, enabled }))).toEqual([
      { name: 'active', enabled: true }, { name: 'inactive', enabled: false },
    ])
    const options = { logging: 'true', priority: '17', profile: 'Domain', program: 'server.exe', zone: 'dmz', scope: '/infra/groups/clients', notes: 'retain', srcZone: 'clients', dstZone: 'servers', permanent: 'false', routerosChain: 'forward' }
    const positional = ['legacy', 'Any', 'Any', 'TCP', '22', 'ALLOW', 'Inbound', ...extras.map((field) => options[field])].join(',')
    const expected = Object.fromEntries(extras.map((field) => [field, ['logging', 'permanent'].includes(field) ? options[field] === 'true' : options[field]]))
    expect(parseCsv(positional, extras)[0]).toMatchObject({ name: 'legacy', enabled: true, ...expected })
  })

  it.each(['false', 'no', '0', 'off'])('recognizes explicit disabled header values (%s) in any column order', (enabled) => {
    expect(parseCsv(`name,enabled,source,destination,service\npaused,${enabled},Any,Any,TCP`)[0].enabled).toBe(false)
  })

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
    expect(text.split('\n')[0]).toBe('name,source,destination,service,ports,action,direction,enabled')
    expect(text).toContain('"Public DNS (1.1.1.1, 8.8.8.8)"')
    const back = parseCsv(text)
    expect(back).toHaveLength(3)
    expect(back.map((r) => [r.name, r.source, r.destination, r.service, r.protocol, r.ports, r.action, r.direction])).toEqual(
      rules.map((r) => [r.name, r.source, r.destination, r.service, r.protocol, r.ports, r.action, r.direction]),
    )
  })

  it('each target gets its own columns, and its example round-trips', () => {
    expect(csvColumns(EXTRA_COLUMNS['azl-nsg']).join()).toBe('name,source,destination,service,ports,action,direction,priority,enabled')
    expect(csvColumns(EXTRA_COLUMNS.nsx).join()).toBe('name,source,destination,service,ports,action,direction,scope,logging,notes,enabled')
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
    expect(text.split('\n')[0]).toBe('name,source,destination,service,ports,action,direction,zone,permanent,logging,enabled')
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
    expect(fragment.startsWith('s=2.')).toBe(true)
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
