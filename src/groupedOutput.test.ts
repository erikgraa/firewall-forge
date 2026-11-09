import { describe, expect, it } from 'vitest'
import { TARGETS } from './generators'
import type { Options } from './generators'
import { sectionRuns } from './grouping'
import type { RuleSection } from './grouping'
import { blankRule } from './model'
import type { Rule, TargetId } from './model'
import { generateGroupedOutput } from './groupedOutput'

const opts: Options = { policyName: 'Firewall', nsxCategory: 'Environment', nsxProject: 'project-one' }
const rule = (id: string, overrides: Partial<Rule> = {}): Rule => ({ ...blankRule(), id, name: id, ...overrides })
const rules = [rule('one', { scope: '/infra/domains/default/groups/workloads', logging: true }), rule('two', { action: 'DROP' }), rule('three', { direction: 'Outbound' })]
const membership = { one: 'first', two: 'first', three: 'second' }
const sections = sectionRuns(rules, membership)
const titles = { first: 'Management', second: 'Applications' }
const generate = (target: TargetId, data = rules, runs = sections, names: Record<string, string> = titles, separate = true, options = opts) => generateGroupedOutput(data, target, options, runs, names, separate)
const original = (target: TargetId, data = rules, options = opts) => TARGETS.find((entry) => entry.id === target)!.generate(data, options)
const restBodies = (code: string) => [...code.matchAll(/\$body = @'\n([\s\S]*?)\n'@/g)].map((match) => JSON.parse(match[1]) as { id: string; display_name: string; sequence_number: number; category: string; rules: Record<string, unknown>[] })
const terraformIds = (code: string) => [...code.matchAll(/resource "nsxt_policy_security_policy" "([^"]+)"/g)].map((match) => match[1])
const policyIds = (target: TargetId, code: string) => target === 'nsx' ? terraformIds(code) : target === 'nsx-sdk' ? [...code.matchAll(/\$policy = Initialize-SecurityPolicy -Id '([^']+)'/g)].map((match) => match[1]) : restBodies(code).map((body) => body.id)

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    Object.values(value).forEach(deepFreeze)
  }
  return value
}

describe('generateGroupedOutput passthrough', () => {
  it.each(['nsx', 'nsx-ps', 'nsx-sdk'] as const)('preserves %s single-policy code byte for byte', (target) => {
    expect(generate(target, rules, sections, titles, false)).toEqual({ code: original(target), warnings: [], blocked: false })
  })

  it.each(TARGETS.filter((target) => !['nsx', 'nsx-ps', 'nsx-sdk', 'windows'].includes(target.id)).map((target) => target.id))('passes %s through even when separate policies are requested', (target) => {
    expect(generate(target)).toEqual({ code: original(target), warnings: [], blocked: false })
  })

  it.each(TARGETS.map((target) => target.id))('returns empty code for an empty %s rule array', (target) => {
    expect(generate(target, [], [])).toEqual({ code: '', warnings: [], blocked: false })
  })
})

describe('Windows grouping is presentation only', () => {
  it('keeps same-section commands adjacent and blank lines only between sections', () => {
    const code = generate('windows').code
    expect(code.startsWith('# Windows Defender Firewall evaluates Block rules before Allow rules, regardless of order.\n\n')).toBe(true)
    const commands = original('windows').split('\n').filter((line) => line.startsWith('New-NetFirewallRule'))
    expect(code.split('\n').filter((line) => line.startsWith('New-NetFirewallRule'))).toEqual(commands)
    expect(code).toContain(`# Group: Management\n${commands[0]}\n${commands[1]}\n\n# Group: Applications\n${commands[2]}`)
    expect(code).not.toContain(`${commands[0]}\n\n${commands[1]}`)
    expect(code.match(/# Group:/g)).toHaveLength(2)
    expect(code.match(/-Group 'Firewall'/g)).toHaveLength(3)
  })

  it('adds no blank spacing within a single section containing multiple rules', () => {
    const runs = sectionRuns(rules, { one: 'first', two: 'first', three: 'first' })
    const header = original('windows', [])
    const commands = original('windows').slice(header.length)
    expect(generate('windows', rules, runs).code).toBe(`${header}# Group: Management\n${commands}`)
  })

  it('keeps enabled commands adjacent across disabled entries and skips disabled-only sections', () => {
    const data = [rule('a'), rule('disabled', { enabled: false }), rule('b'), rule('empty', { enabled: false }), rule('c')]
    const runs = sectionRuns(data, { a: 'first', disabled: 'first', b: 'first', empty: 'hidden', c: 'second' })
    const header = original('windows', [])
    const command = (entry: Rule) => original('windows', [entry]).slice(header.length, -1)
    expect(generate('windows', data, runs).code).toBe(`${header}# Group: Management\n${command(data[0])}\n${command(data[2])}\n\n# Group: Applications\n${command(data[4])}\n`)
  })

  it('preserves section spacing and adjacent rules within continued runs', () => {
    const data = [rule('a'), rule('b'), rule('c'), rule('d'), rule('disabled', { enabled: false }), rule('e')]
    const runs = sectionRuns(data, { a: 'first', b: 'first', c: 'second', d: 'first', disabled: 'first', e: 'first' })
    const header = original('windows', [])
    const command = (entry: Rule) => original('windows', [entry]).slice(header.length, -1)
    expect(generate('windows', data, runs).code).toBe(`${header}# Group: Management\n${command(data[0])}\n${command(data[1])}\n\n# Group: Applications\n${command(data[2])}\n\n# Group: Management (continued)\n${command(data[3])}\n${command(data[5])}\n`)
  })

  it('uses array order, not section or entry order', () => {
    const scrambled: RuleSection[] = sections.toReversed().map((section) => ({ ...section, entries: section.entries.toReversed() }))
    expect(generate('windows', rules, scrambled).code).toBe(generate('windows').code)
  })

  it('labels continued runs without changing rule order', () => {
    const runs = sectionRuns(rules, { one: 'first', two: 'second', three: 'first' })
    const code = generate('windows', rules, runs).code
    expect(code).toContain('# Group: Management (continued)\nNew-NetFirewallRule -DisplayName \'three\'')
    expect(code.match(/# Group:/g)).toHaveLength(3)
  })

  it('omits disabled rules and disabled-only headings', () => {
    const data = rules.map((entry) => ({ ...entry, enabled: entry.id === 'three' }))
    const code = generate('windows', data, sectionRuns(data, membership)).code
    expect(code).not.toContain('# Group: Management')
    expect(code).not.toContain("-DisplayName 'one'")
    expect(code.match(/# Group:/g)).toHaveLength(1)
    expect(generate('windows', data.map((entry) => ({ ...entry, enabled: false })), []).code).toBe('')
  })

  it('keeps every line of arbitrary multiline titles commented', () => {
    const names = { first: "Admin`\r\n'@\nInvoke-Expression 'bad'\rWrite-Output bad\u2028more\u2029last\u0085final", second: 'Apps' }
    const code = generate('windows', rules, sections, names).code
    for (const text of ["'@", "Invoke-Expression 'bad'", 'Write-Output bad', 'more', 'last', 'final']) expect(code).toContain(`\n# ${text}\n`)
    const executable = code.split('\n').filter((line) => line && !line.startsWith('#'))
    expect(executable).toEqual(original('windows').split('\n').filter((line) => line.startsWith('New-NetFirewallRule')))
  })
})

describe('separate NSX policies', () => {
  it('emits one Terraform setup/project lookup and ordered resources retaining rule blocks', () => {
    const output = generate('nsx')
    const code = output.code
    expect(output.blocked).toBe(false)
    expect(code.match(/terraform \{/g)).toHaveLength(1)
    expect(code.match(/data "nsxt_policy_project"/g)).toHaveLength(1)
    expect(code.match(/resource "nsxt_policy_security_policy"/g)).toHaveLength(2)
    expect(code.match(/category     = "Environment"/g)).toHaveLength(2)
    expect(code.match(/project_id = data.nsxt_policy_project.project.id/g)).toHaveLength(2)
    expect(code).toContain('scope              = ["/infra/domains/default/groups/workloads"]')
    expect(code).toContain('logged             = true')
    const ids = terraformIds(code)
    expect(code).toContain(`nsx_id       = "${ids[0]}"`)
    expect(code).toContain(`depends_on = [nsxt_policy_security_policy.${ids[0]}]`)
    expect(code).toContain('sequence_number = 10')
    expect(code).toContain('sequence_number = 20')
    for (const data of [rules.slice(0, 2), rules.slice(2)]) {
      const body = original('nsx', data).match(/\n  rule \{[\s\S]*\n  \}/)![0]
      expect(code).toContain(body)
    }
    expect(code.indexOf('display_name       = "one"')).toBeLessThan(code.indexOf('display_name       = "two"'))
    expect(code.indexOf('display_name       = "two"')).toBeLessThan(code.indexOf('display_name       = "three"'))
    expect(output.warnings.join(' ')).toMatch(/existing NSX policies/)
    expect(output.warnings.join(' ')).toMatch(/not atomic/)
    expect(output.warnings.join(' ')).toMatch(/No live NSX or Terraform apply verification/)
    expect(output.warnings.join(' ')).toMatch(/not persisted/)
  })

  it('emits one REST connection setup, category/project and explicit policy/rule order', () => {
    const code = generate('nsx-ps').code
    const bodies = restBodies(code)
    expect(bodies).toHaveLength(2)
    expect(code.match(/\$nsx  =/g)).toHaveLength(1)
    expect(code.match(/\$cred = Get-Credential/g)).toHaveLength(1)
    expect(code.match(/Invoke-RestMethod -Method Patch/g)).toHaveLength(2)
    expect(code.match(/orgs\/default\/projects\/project-one\/infra\/domains\/default/g)).toHaveLength(2)
    expect(bodies.map((body) => body.sequence_number)).toEqual([10, 20])
    expect(bodies.map((body) => body.category)).toEqual(['Environment', 'Environment'])
    expect(bodies.map((body) => body.display_name)).toEqual(['Firewall — Management', 'Firewall — Applications'])
    expect(bodies.map((body) => body.rules)).toEqual([restBodies(original('nsx-ps', rules.slice(0, 2)))[0].rules, restBodies(original('nsx-ps', rules.slice(2)))[0].rules])
    for (const body of bodies) expect(code).toContain(`/security-policies/${body.id}`)
    expect(code.match(/if \(-not \$\?\) \{ throw/g)).toHaveLength(2)
  })

  it.each(['nsx', 'nsx-ps', 'nsx-sdk'] as const)('%s uses stable identities under renaming and anchor deletion', (target) => {
    const getIds = (code: string) => policyIds(target, code)
    const ids = getIds(generate(target).code)
    expect(getIds(generate(target, rules, sections, { first: 'Renamed', second: 'Also renamed' }).code)).toEqual(ids)
    const remaining = rules.slice(1)
    expect(getIds(generate(target, remaining, sectionRuns(remaining, membership)).code)).toEqual(ids)
    expect(getIds(generate(target, rules, sections.map((section) => ({ ...section, key: 'changed-anchor' }))).code)).toEqual(ids)
  })

  it.each(['nsx', 'nsx-ps', 'nsx-sdk'] as const)('%s avoids title/slug/Unicode identity collisions without sorting', (target) => {
    const data = [rule('a'), rule('b'), rule('c'), rule('d'), rule('e')]
    const groups = { a: 'a b', b: 'a-b', c: '東京', d: '東亰', e: '' }
    const runs = sectionRuns(data, groups).toReversed()
    const code = generate(target, data, runs, Object.fromEntries(Object.values(groups).map((group) => [group, 'Same title']))).code
    const ids = policyIds(target, code)
    expect(new Set(ids).size).toBe(5)
    expect(ids.every((id) => /^[a-z0-9_]+$/.test(id))).toBe(true)
    const expected = ['a', 'b', 'c', 'd', 'e']
    const names = target === 'nsx' ? [...code.matchAll(/display_name       = "([^"]+)"/g)].map((match) => match[1]) : target === 'nsx-sdk' ? [...code.matchAll(/Initialize-Rule -Id '[^']+' `\n    -DisplayName '([^']+)'/g)].map((match) => match[1]) : restBodies(code).flatMap((body) => body.rules.map((entry) => entry.display_name))
    expect(names).toEqual(expected)
  })

  it('escapes multiline Unicode, quotes, here-string terminators and HCL interpolation in titles', () => {
    const name = '東京 "quote" \\ ${file("secret")} %{if true}\n\'@\nInvoke-Expression bad'
    const names = { first: name, second: name }
    const tf = generate('nsx', rules, sections, names).code
    expect(tf).toContain('$${file(')
    expect(tf).toContain('%%{if true}')
    expect(tf).toContain('\\n\'@\\nInvoke-Expression bad')
    expect(tf).toContain('\\"quote\\"')
    expect(tf).toContain('東京')
    expect(tf).not.toContain('\nInvoke-Expression bad')
    const ps = generate('nsx-ps', rules, sections, names).code
    expect(restBodies(ps).map((body) => body.display_name)).toEqual([`Firewall — ${name}`, `Firewall — ${name}`])
    expect(ps.match(/^'@$/gm)).toHaveLength(2)
    expect(ps).not.toContain('\nInvoke-Expression bad')
  })

  it.each(['nsx', 'nsx-ps', 'nsx-sdk'] as const)('%s omits disabled and empty sections without empty policies', (target) => {
    const data = rules.map((entry) => ({ ...entry, enabled: entry.id === 'three' }))
    const runs = [...sectionRuns(data, membership), { key: 'empty', group: 'empty', continued: false, entries: [] }]
    const code = generate(target, data, runs).code
    const ids = policyIds(target, code)
    expect(ids).toHaveLength(1)
    expect(code).not.toContain('Management')
    const disabled = data.map((entry) => ({ ...entry, enabled: false }))
    expect(generate(target, disabled, sectionRuns(disabled, membership)).code).toBe('')
  })

  it.each(['nsx', 'nsx-ps', 'nsx-sdk'] as const)('%s retains no-project/default-category behavior', (target) => {
    const code = generate(target, rules, sections, titles, true, { policyName: 'Plain' }).code
    expect(code).not.toContain('project_id')
    expect(code).not.toContain('/projects/')
    expect(code).toContain('Application')
  })

  it.each(['nsx', 'nsx-ps', 'nsx-sdk'] as const)('%s blocks continued membership instead of reordering or merging', (target) => {
    const runs = sectionRuns(rules, { one: 'first', two: 'second', three: 'first' })
    const output = generate(target, rules, runs)
    expect(output.blocked).toBe(true)
    expect(output.warnings.join(' ')).toMatch(/noncontiguous membership/)
    expect(output.code.trim().split('\n').every((line) => line.startsWith('#'))).toBe(true)
  })

  it.each(['nsx', 'nsx-ps', 'nsx-sdk'] as const)('%s blocks stale metadata without executable output', (target) => {
    const output = generate(target, rules, sections.slice(1))
    expect(output.blocked).toBe(true)
    expect(output.warnings[0]).toMatch(/does not match/)
    expect(output.code).not.toMatch(/Invoke-|resource "/)
  })

  it('emits SDK policies using verified ordering arguments and one connection', () => {
    const output = generate('nsx-sdk')
    const code = output.code
    expect(output.blocked).toBe(false)
    expect(code.match(/^Import-Module VMware.Sdk.Nsx.Policy$/gm)).toHaveLength(1)
    expect(code.match(/^Connect-NsxServer/gm)).toHaveLength(1)
    expect(code.match(/\$policy = Initialize-SecurityPolicy/g)).toHaveLength(2)
    expect(code).toContain("-DisplayName 'Firewall — Management' -SequenceNumber 10 -Category 'Environment'")
    expect(code).toContain("-DisplayName 'Firewall — Applications' -SequenceNumber 20 -Category 'Environment'")
    expect(code.match(/Invoke-OrgsOrgIdProjectsProjectIdInfraPatchSecurityPolicyForDomain -OrgId 'default' -ProjectId 'project-one' -DomainId 'default'/g)).toHaveLength(2)
    for (const id of policyIds('nsx-sdk', code)) expect(code).toContain(`-SecurityPolicyId '${id}' -SecurityPolicy $policy`)
    for (const data of [rules.slice(0, 2), rules.slice(2)]) {
      const source = original('nsx-sdk', data)
      const ruleCode = source.slice(source.indexOf('$rules = @()'), source.indexOf('$policy ='))
      expect(code).toContain(ruleCode)
    }
    expect(code).toContain("-Scope @('/infra/domains/default/groups/workloads')")
    expect(code.match(/if \(-not \$\?\) \{ throw/g)).toHaveLength(2)
    expect(output.warnings.join(' ')).toContain('4.1.2.22644671')
    const global = generate('nsx-sdk', rules, sections, titles, true, { policyName: 'Plain' }).code
    expect(global.match(/Invoke-PatchSecurityPolicyForDomain -DomainId 'default'/g)).toHaveLength(2)
  })

  it('escapes SDK title quotes, interpolation, multiline text and here-string terminators', () => {
    const name = "東京 ${Get-Credential} %{if true} 'quote'\r\n'@\nInvoke-Expression bad"
    const code = generate('nsx-sdk', rules, sections, { first: name, second: 'Apps' }).code
    expect(code).toContain("-DisplayName ('Firewall — 東京 ${Get-Credential} %{if true} ''quote''")
    expect(code).toContain("' + [char]13 + '' + [char]10 + '''@' + [char]10 + 'Invoke-Expression bad')")
    expect(code).not.toContain('\nInvoke-Expression bad')
    expect(code).not.toContain("\n'@")
    expect(policyIds('nsx-sdk', code)).toEqual(policyIds('nsx-sdk', generate('nsx-sdk').code))
  })

  it.each(['nsx', 'nsx-ps', 'nsx-sdk'] as const)('%s blocks a continued flag even without visible duplicate membership', (target) => {
    const output = generate(target, rules, sections.map((section, index) => ({ ...section, continued: index === 1 })))
    expect(output.blocked).toBe(true)
    expect(output.warnings[0]).toMatch(/continued sections/)
  })

  it.each(['nsx', 'nsx-ps', 'nsx-sdk'] as const)('%s does not merge across disabled-only intervening membership', (target) => {
    const data = rules.map((entry) => ({ ...entry, enabled: entry.id !== 'two' }))
    const output = generate(target, data, sectionRuns(data, { one: 'first', two: 'second', three: 'first' }))
    expect(output.blocked).toBe(true)
    const disabled = data.map((entry) => ({ ...entry, enabled: false }))
    expect(generate(target, disabled, sectionRuns(disabled, { one: 'first', two: 'second', three: 'first' })).code).toBe('')
  })

  it.each(['nsx', 'nsx-ps', 'nsx-sdk'] as const)('%s blocks duplicate or mismatched metadata indices', (target) => {
    const duplicate = [...sections, sections[0]]
    expect(generate(target, rules, duplicate).blocked).toBe(true)
    const mismatch = sections.map((section) => ({ ...section, entries: section.entries.map((entry) => ({ ...entry, index: 0 })) }))
    expect(generate(target, rules, mismatch).blocked).toBe(true)
  })

  it.each(['nsx', 'nsx-ps', 'nsx-sdk', 'windows'] as const)('%s supports an ungrouped fallback when no section metadata exists', (target) => {
    const output = generate(target, rules, [], {})
    expect(output.blocked).toBe(false)
    expect(output.code).toContain('Ungrouped rules')
    if (target !== 'windows') expect(policyIds(target, output.code)).toHaveLength(1)
  })

  it('blocks overlong group IDs rather than truncating into collisions', () => {
    const output = generate('nsx', rules, sectionRuns(rules, { one: 'x'.repeat(64), two: 'x'.repeat(64), three: 'second' }))
    expect(output.blocked).toBe(true)
    expect(output.warnings[0]).toMatch(/255-character limit/)
  })

  it.each(['nsx', 'nsx-ps', 'nsx-sdk', 'windows'] as const)('%s never mutates rules, options, titles or sections', (target) => {
    const data = structuredClone(rules)
    const runs = sectionRuns(data, membership)
    const options = structuredClone(opts)
    const names = structuredClone(titles)
    const before = JSON.stringify({ data, runs, options, names })
    deepFreeze(data); deepFreeze(runs); deepFreeze(options); deepFreeze(names)
    generate(target, data, runs, names, true, options)
    expect(JSON.stringify({ data, runs, options, names })).toBe(before)
  })
})
