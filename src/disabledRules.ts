import type { Rule, TargetId } from './model'

const nativeDisabledTargets: ReadonlySet<TargetId> = new Set([
  'nsx', 'nsx-ps', 'nsx-sdk', 'windows', 'fmc',
  'panos', 'panos-1x', 'panos-ansible', 'mikrotik', 'mikrotik-tf',
])

export const supportsDisabledRules = (target: TargetId): boolean => nativeDisabledTargets.has(target)

export function disabledRuleWarning(rules: Rule[], target: TargetId): string | undefined {
  const count = rules.filter((rule) => !rule.enabled).length
  if (!count || supportsDisabledRules(target)) return
  return `${count} disabled rule${count === 1 ? '' : 's'} omitted: this output format cannot retain a native disabled rule. They remain in saved/exported/shared rule data. Omission does not disable an existing deployed rule and may remove previously managed rules when applying a replacement policy or Terraform plan. Review the generated changes before applying.`
}

export function blockedDisabledOutput(messages: string[], target: TargetId): string {
  const comments = ['BLOCKED: fix rule errors, including disabled rules; no configuration generated.', ...messages]
    .flatMap((message) => message.split(/\r\n|[\n\r\u2028\u2029\u0085]/u).map((line) => `# ${line}`)).join('\n')
  const terraform = ['nsx', 'fmc', 'panos', 'panos-1x', 'mikrotik-tf'].includes(target)
  return `${comments}\n${terraform ? '# Prevent an empty blocked configuration from removing managed rules.\nterraform {\n  required_version = "< 0.0.0"\n}\n' : ''}`
}
