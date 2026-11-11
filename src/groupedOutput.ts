import { TARGETS } from './generators'
import { disabledRuleWarning } from './disabledRules'
import { disabledOutputErrors, validate } from './validate'
import type { Options } from './generators'
import type { RuleSection } from './grouping'
import type { Rule, TargetId } from './model'

export interface GroupedOutput {
  code: string
  warnings: string[]
  blocked: boolean
}

const windowsSections = 'Windows sections are editor organization and output comments, not native Windows firewall policy objects or evaluation precedence.'
const placement = 'Review placement versus existing NSX policies in the selected category and project. Generated policy sequence numbers are unique within this output, not reserved against existing policies. Updates are not atomic across policies.'
const unverified = 'No live NSX or Terraform apply verification has been performed.'
const comment = (text: string) => text.split(/\r\n|[\n\r\u2028\u2029\u0085]/u).map((line) => `# ${line}`).join('\n')
const hclString = (text: string) => JSON.stringify(text).replace(/\$\{/g, '$$$${').replace(/%\{/g, '%%{')
const psString = (text: string) => {
  const quoted = `'${text.replace(/'/g, "''")}'`
  return /[\r\n\u2028\u2029\u0085]/u.test(text)
    ? `(${quoted.replace(/[\r\n\u2028\u2029\u0085]/gu, (character) => `' + [char]${character.charCodeAt(0)} + '`)})`
    : quoted
}

// Lossless UTF-16 encoding avoids slug/hash collisions and stays stable after renaming
// or deleting a run's first rule. The prototype caps generated IDs at 255 characters.
const policyId = (group: string) => `section_${Array.from({ length: group.length }, (_, i) => group.charCodeAt(i).toString(16).padStart(4, '0')).join('') || 'empty'}`

function runsInRuleOrder(rules: Rule[], sections: RuleSection[]) {
  const membership = new Map<number, { group: string; continued: boolean }>()
  let invalid = false
  for (const section of sections) {
    for (const entry of section.entries) {
      if (rules[entry.index]?.id !== entry.rule.id || membership.has(entry.index)) {
        invalid = true
        continue
      }
      membership.set(entry.index, { group: section.group, continued: section.continued })
    }
  }
  if (sections.length && membership.size !== rules.length) invalid = true
  const seen = new Set<string>()
  const runs: { group: string; continued: boolean; rules: Rule[] }[] = []
  rules.forEach((rule, index) => {
    const meta = membership.get(index) ?? { group: 'unsectioned', continued: false }
    let run = runs[runs.length - 1]
    if (!run || run.group !== meta.group) {
      run = { group: meta.group, continued: meta.continued || seen.has(meta.group), rules: [] }
      seen.add(meta.group)
      runs.push(run)
    } else {
      run.continued ||= meta.continued
    }
    run.rules.push(rule)
  })
  return { runs, invalid }
}

/**
 * Preview-only presentation adapter; original generators remain authoritative for rules.
 * Policy ordering: unique sequence_number values (0..999999), not creation order.
 * Verified references for the new fields:
 * https://raw.githubusercontent.com/vmware/terraform-provider-nsxt/v3.12.0/docs/resources/policy_security_policy.md
 * https://raw.githubusercontent.com/vmware/terraform-provider-nsxt/v3.12.0/nsxt/resource_nsxt_policy_security_policy.go
 * https://developer.broadcom.com/xapis/nsx-t-data-center-rest-api/latest/schemas_SecurityPolicy.html
 * https://developer.broadcom.com/xapis/nsx-t-data-center-rest-api/latest/method_PatchSecurityPolicyForDomain.html
 * https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule?view=windowsserver2025-ps
 * SDK -SequenceNumber and both PATCH command signatures verified in VMware-authored
 * package help: netcoreapp3.1/VMware.Sdk.Nsx.Policy.Cmdlets.dll-Help.xml, version 4.1.2.22644671.
 * https://www.powershellgallery.com/packages/VMware.Sdk.Nsx.Policy/4.1.2.22644671
 * https://www.powershellgallery.com/api/v2/package/VMware.Sdk.Nsx.Policy/4.1.2.22644671
 * Terraform retains the configured provider constraint (3.x, verified against 3.12.0).
 * Rule sequence numbers remain consistent with native array order, as required by 3.12.0.
 */
export function generateGroupedOutput(
  rules: Rule[], targetId: TargetId, options: Options, sections: RuleSection[],
  titles: Record<string, string>, separatePolicies: boolean,
): GroupedOutput {
  const omission = disabledRuleWarning(rules, targetId)
  const result = (code: string, warnings: string[] = [], blocked = false): GroupedOutput => ({ code, warnings: omission ? [omission, ...warnings] : warnings, blocked })
  const block = (reason: string) => result(comment(`Grouped output blocked: ${reason}`) + '\n', [reason, unverified], true)
  if (!rules.length) return result('')
  const target = TARGETS.find((candidate) => candidate.id === targetId)!
  const errors = targetId === 'azfw-ps' || targetId === 'azfw-cli'
    ? validate(rules.filter((rule) => rule.enabled), targetId).filter((issue) => issue.level === 'error')
    : disabledOutputErrors(rules, targetId)
  if (errors.length) return result(target.generate(rules, options), [targetId === 'azfw-ps' || targetId === 'azfw-cli' ? 'Generation blocked: fix enabled Azure rule errors.' : 'Generation blocked: fix rule errors, including disabled rules.', ...errors.map((issue) => issue.message)], true)
  const isNsx = targetId === 'nsx' || targetId === 'nsx-ps' || targetId === 'nsx-sdk'
  if (targetId !== 'windows' && (!isNsx || !separatePolicies)) return result(target.generate(rules, options))

  const { runs, invalid } = runsInRuleOrder(rules, sections)
  const outputRuns = runs
  const title = (group: string) => titles[group] ?? (group === 'unsectioned' ? 'Ungrouped rules' : group)

  if (targetId === 'windows') {
    const header = target.generate([], options)
    const blocks = outputRuns.map((run) => {
      const heading = comment(`Group: ${title(run.group)}${run.continued ? ' (continued)' : ''}`)
      const commands = run.rules.map((rule) => target.generate([rule], options).slice(header.length, -1))
      return `${heading}\n${commands.join('\n')}`
    })
    return result(blocks.length ? `${header}${blocks.join('\n\n')}\n` : '', runs.some((run) => run.group !== 'unsectioned') ? [windowsSections] : [])
  }

  if (invalid) return block('Section metadata does not match the original rule array. Refresh grouping before generating separate policies.')
  if (!outputRuns.length) return result('')
  if (runs.some((run) => run.continued)) return block('A group has repeated noncontiguous membership (continued sections). Separate policies would require merging or reordering rules; make each group contiguous first.')
  if (outputRuns.length > 99999) return block('Too many sections for unique policy sequence numbers within the supported NSX range.')
  if (outputRuns.some((run) => policyId(run.group).length > 255)) return block('A section identity is too long for the prototype collision-safe policy ID encoding (255-character limit). Use a shorter metadata group identity.')

  const placeholder = 'grouped-policy-placeholder'
  let setup = ''
  const blocks = outputRuns.map((run, index) => {
    const id = policyId(run.group)
    const displayName = `${options.policyName} — ${title(run.group)}`
    const code = target.generate(run.rules, { ...options, policyName: placeholder })
    const sequence = (index + 1) * 10
    if (targetId === 'nsx') {
      const start = code.indexOf('resource "nsxt_policy_security_policy"')
      if (!index) setup = code.slice(0, start)
      const dependency = index ? `  depends_on = [nsxt_policy_security_policy.${policyId(outputRuns[index - 1].group)}]\n` : ''
      return code.slice(start)
        .replace(`"${placeholder}" {`, `"${id}" {`)
        .replace(`  display_name = "${placeholder}"`, () => `  display_name = ${hclString(displayName)}\n  nsx_id       = "${id}"\n  sequence_number = ${sequence}\n${dependency}`)
        .trimEnd()
    }
    if (targetId === 'nsx-sdk') {
      const begin = code.indexOf('$rules = @()')
      if (!index) setup = code.slice(0, begin)
      return code.slice(begin)
        .replace(`$policy = Initialize-SecurityPolicy -Id '${placeholder}' -DisplayName '${placeholder}'`, () => `$policy = Initialize-SecurityPolicy -Id '${id}' -DisplayName ${psString(displayName)} -SequenceNumber ${sequence}`)
        .replace(`-SecurityPolicyId '${placeholder}'`, `-SecurityPolicyId '${id}'`)
        .trimEnd() + `\nif (-not $?) { throw ${psString(`Failed to apply section ${id}; stopping before the next policy.`)} }`
    }
    const begin = code.indexOf("$body = @'\n")
    const bodyStart = begin + "$body = @'\n".length
    const end = code.indexOf("\n'@", bodyStart)
    if (!index) setup = code.slice(0, begin)
    const body = JSON.parse(code.slice(bodyStart, end)) as Record<string, unknown>
    body.id = id
    body.display_name = displayName
    body.sequence_number = sequence
    const command = code.slice(end + "\n'@".length).replace(`/security-policies/${placeholder}`, `/security-policies/${id}`).trimEnd()
    // JSON escapes embedded newlines, so a title cannot terminate this here-string.
    return `$body = @'\n${JSON.stringify(body, null, 2)}\n'@${command}\nif (-not $?) { throw ${psString(`Failed to apply section ${id}; stopping before the next policy.`)} }`
  })
  const warnings = [placement, unverified]
  if (targetId === 'nsx-sdk') warnings.push('SDK ordering arguments were verified against VMware.Sdk.Nsx.Policy 4.1.2.22644671 package help; check compatibility with the installed module and NSX release before execution.')
  return result(`${comment(warnings.join('\n'))}\n\n${setup}${blocks.join('\n\n')}\n`, warnings)
}
