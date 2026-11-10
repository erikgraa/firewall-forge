import { ENDPOINTS, SERVICES } from './model'
import type { Rule } from './model'

const ipv4 = (value: string): boolean => {
  const [address, prefix, ...rest] = value.split('/')
  const octets = address.split('.')
  return !rest.length && octets.length === 4 && octets.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
    && (prefix === undefined || /^(0|[1-9]\d?)$/.test(prefix) && Number(prefix) <= 32)
}
const addresses = (value: string): string[] => ENDPOINTS[value.trim()]?.nsx ?? value.split(',').map((part) => part.trim()).filter(Boolean)
const zones = (value: string): string[] => value.split(',').map((part) => part.trim()).filter(Boolean)

export function fmcAnsibleErrors(rules: Rule[]): string[] {
  const errors: string[] = []
  const names = new Set<string>()
  for (const rule of rules) {
    const label = rule.name || 'Unnamed rule'
    for (const field of ['source', 'destination', 'srcZone', 'dstZone', 'ports'] as const) {
      const value = rule[field].trim()
      if ((field === 'source' || field === 'destination') && !value) errors.push(`${label}: ${field} must be explicit; use Any for an unrestricted matcher.`)
      if (value && !ENDPOINTS[value] && value.split(',').some((part) => !part.trim())) errors.push(`${label}: ${field} contains an empty list entry.`)
      const items = field === 'source' || field === 'destination' ? addresses(value) : zones(value)
      if (items.length > 200) errors.push(`${label}: ${field} exceeds the supported maximum of 200 match items.`)
    }
    if (!rule.name.trim() || names.has(rule.name)) errors.push(`${label}: a unique nonempty FMC rule name is required.`)
    names.add(rule.name)
    if (rule.service !== 'Custom' && !SERVICES[rule.service]) errors.push(`${label}: unknown FMC service.`)
    for (const field of ['priority', 'scope', 'program', 'zone'] as const) {
      if (rule[field].trim()) errors.push(`${label}: FMC Ansible cannot represent ${field}; clear it before generating.`)
    }
    if (rule.profile !== 'Any' || !rule.permanent) errors.push(`${label}: FMC Ansible cannot represent Windows profiles or runtime-only rules.`)
    if (rule.routerosChain && rule.routerosChain !== 'Auto') errors.push(`${label}: FMC Ansible cannot represent an explicit RouterOS chain; reset it to Auto before generating.`)
    if (!['TCP', 'UDP', 'ICMP', 'ANY'].includes(rule.protocol) || !['ALLOW', 'DROP', 'REJECT'].includes(rule.action)) errors.push(`${label}: unsupported FMC protocol or action.`)
    const service = SERVICES[rule.service]
    if (service && (service.protocol !== rule.protocol || service.ports !== rule.ports)) errors.push(`${label}: service and protocol/ports disagree.`)
    if (['ANY', 'ICMP'].includes(rule.protocol) && rule.ports.trim()) errors.push(`${label}: ports cannot be represented for ANY or ICMP; ICMP output is IPv4 all types/codes.`)
    for (const port of rule.ports.split(',').filter((part) => part.trim())) {
      const parts = port.trim().split('-')
      if (parts.length > 2 || parts.some((part) => !/^\d+$/.test(part) || Number(part) < 1 || Number(part) > 65535) || Number(parts[0]) > Number(parts[1] ?? parts[0])) errors.push(`${label}: invalid FMC port or reversed range "${port.trim()}".`)
    }
    for (const field of ['source', 'destination'] as const) {
      for (const value of addresses(rule[field])) {
        if ((/^\d+(?:\.\d+){3}(?:\/.*)?$/.test(value) || value.includes(':') || value.includes('/')) && !ipv4(value)) errors.push(`${label}: FMC Ansible accepts IPv4 host/CIDR literals or existing Network object names, not "${value}".`)
      }
    }
  }
  return errors
}

class Expression {
  readonly value: string
  constructor(value: string) { this.value = value }
}
const expr = (value: string) => new Expression(`{{ ${value} }}`)
type Yaml = string | number | boolean | Expression | Yaml[] | { [key: string]: Yaml }

// User text is data, never executable Ansible/Jinja content.
function yaml(value: Yaml, indent = 0): string {
  const pad = ' '.repeat(indent)
  if (value instanceof Expression) return JSON.stringify(value.value)
  if (typeof value === 'string') return `!unsafe ${JSON.stringify(value)}`
  if (typeof value !== 'object') return String(value)
  if (Array.isArray(value)) return value.length ? '\n' + value.map((item) => `${pad}- ${yaml(item, indent + 2)}`).join('\n') : '[]'
  const entries = Object.entries(value)
  return entries.length ? '\n' + entries.map(([key, item]) => `${pad}${key}: ${yaml(item, indent + 2)}`).join('\n') : '{}'
}

const ownership = 'Managed by Firewall Forge FMC Ansible v1; dedicated BLOCK-default policy'
const moduleName = 'cisco.fmcansible.fmc_configuration'
const quoted = (value: string) => JSON.stringify(value)

export function fmcAnsible(rules: Rule[], { policyName }: { policyName: string }): string {
  if (!rules.length) return ''
  const errors = fmcAnsibleErrors(rules)
  if (!policyName.trim()) errors.push('A dedicated FMC policy name is required.')
  if (errors.length) return `# BLOCKED: ${errors.join('\n').split(/[\r\n\u2028\u2029\u0085]/u).join('\n# ')}\n- hosts: fmc\n  gather_facts: false\n  tasks:\n    - ansible.builtin.fail:\n        msg: FMC output blocked; fix validation errors before applying.\n`

  const tasks: string[] = []
  const moduleTask = (name: string, operation: string, extra: string, when?: string) => {
    tasks.push(`    - name: ${name}\n      ${moduleName}:\n        operation: ${operation}\n        path_params:\n          domainUUID: "{{ fmc_domain_uuid }}"\n${extra}${when ? `      when: ${when}\n` : ''}`)
  }
  tasks.push(`    - name: Require explicit domain and a normal configuration run\n      ansible.builtin.assert:\n        that:\n          - fmc_domain_uuid is defined\n          - fmc_domain_uuid is string\n          - fmc_domain_uuid is match('^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$')\n          - not ansible_check_mode\n        fail_msg: Set fmc_domain_uuid in inventory; check mode cannot validate creation-dependent policy guards.\n`)
  moduleTask('Find the dedicated policy across all pages', 'getAllAccessPolicy', '        filters:\n          name: "{{ forge_policy_name }}"\n        register_as: forge_policy_matches\n')
  tasks.push(`    - name: Reject ambiguous policy identity\n      ansible.builtin.assert:\n        that: forge_policy_matches | length <= 1\n        fail_msg: More than one policy matches; no configuration was changed.\n`)
  moduleTask('Read the complete existing policy', 'getAccessPolicy', '          objectId: "{{ forge_policy_matches[0].id }}"\n        register_as: forge_existing_policy\n', 'forge_policy_matches | length == 1')
  const policyGuard = `    - name: Refuse to adopt or modify an unrelated policy\n      ansible.builtin.assert:\n        that:\n          - forge_existing_policy.name == forge_policy_name\n          - forge_existing_policy.description | default('') == forge_ownership\n          - forge_existing_policy.defaultAction.action | default('') == 'BLOCK'\n          - forge_existing_policy.defaultAction | dict2items | rejectattr('key', 'in', ['id', 'type', 'action']) | selectattr('value') | list | length == 0\n          - not (forge_existing_policy.metadata | default({})).get('readOnly', false)\n          - not (forge_existing_policy.metadata | default({})).get('basePolicy', {})\n          - not (forge_existing_policy.metadata | default({})).get('parentPolicy', {})\n          - forge_existing_policy | dict2items | rejectattr('key', 'in', forge_policy_fields) | selectattr('value') | list | length == 0\n        fail_msg: Existing policy is not a plain dedicated Forge BLOCK policy; review it manually. No configuration was changed.\n      when: forge_policy_matches | length == 1\n`
  tasks.push(policyGuard)

  const refs = new Map<string, string>()
  const reference = (name: string, type: 'Network' | 'SecurityZone'): { [key: string]: Yaml } => {
    const key = `${type}:${name}`
    let variable = refs.get(key)
    if (!variable) {
      variable = `forge_ref_${refs.size}`
      refs.set(key, variable)
      moduleTask(`Resolve existing ${type} reference ${refs.size}`, type === 'Network' ? 'getAllNetworkObject' : 'getAllSecurityZone', `        filters:\n          name: !unsafe ${quoted(name)}\n        register_as: ${variable}\n`)
      tasks.push(`    - name: Require a unique existing ${type} reference ${refs.size}\n      ansible.builtin.assert:\n        that:\n          - ${variable} | length == 1\n          - ${variable}[0].type == '${type}'\n          - ${variable}[0].id is defined\n        fail_msg: Missing or ambiguous object reference; create or rename it in FMC first. No configuration was changed.\n`)
    }
    return { id: expr(`${variable}[0].id`), type }
  }
  const network = (value: string): { [key: string]: Yaml } => {
    const items = addresses(value)
    const literals = items.filter(ipv4).map((address) => ({ type: address.includes('/') ? 'Network' : 'Host', value: address }))
    const objects = items.filter((address) => !ipv4(address)).map((name) => reference(name, 'Network'))
    return { ...(literals.length ? { literals } : {}), ...(objects.length ? { objects } : {}) }
  }
  const desired: Yaml[] = rules.map((rule) => {
    const destinationPorts: { [key: string]: Yaml } = {}
    if (rule.protocol === 'ICMP') destinationPorts.literals = [{ type: 'ICMPv4PortLiteral', protocol: '1' }]
    else if (rule.protocol !== 'ANY') {
      const ports = rule.ports.split(',').map((port) => port.trim()).filter(Boolean)
      destinationPorts.literals = (ports.length ? ports : ['']).map((port) => ({ type: 'PortLiteral', protocol: rule.protocol === 'TCP' ? '6' : '17', ...(port ? { port } : {}) }))
    }
    const fields: { [key: string]: Yaml } = {
      name: rule.name, type: 'AccessRule', enabled: rule.enabled,
      action: { ALLOW: 'ALLOW', DROP: 'BLOCK', REJECT: 'BLOCK_RESET' }[rule.action],
      logBegin: rule.logging && rule.action !== 'ALLOW', logEnd: rule.logging && rule.action === 'ALLOW', sendEventsToFMC: rule.logging, logFiles: false,
      ...(rule.notes.trim() ? { description: rule.notes.trim() } : {}),
    }
    for (const [key, value] of Object.entries({ sourceNetworks: network(rule.source), destinationNetworks: network(rule.destination), sourceZones: { objects: zones(rule.srcZone).map((name) => reference(name, 'SecurityZone')) }, destinationZones: { objects: zones(rule.dstZone).map((name) => reference(name, 'SecurityZone')) }, destinationPorts })) {
      if (Object.values(value).some((items) => Array.isArray(items) && items.length)) fields[key] = value
    }
    return fields
  })

  tasks.push(`    - name: Initialize the existing rule list\n      ansible.builtin.set_fact:\n        forge_existing_rules: []\n`)
  moduleTask('Read every existing rule in API evaluation order', 'getAllAccessRule', '          containerUUID: "{{ forge_policy_matches[0].id }}"\n        query_params:\n          expanded: true\n        filters:\n          type: AccessRule\n        register_as: forge_existing_rules\n', 'forge_policy_matches | length == 1')
  tasks.push(`    - name: Reject deletions, insertions and reordering before any writes\n      ansible.builtin.assert:\n        that:\n          - forge_existing_rules | length <= forge_desired_rules | length\n          - forge_existing_rules | map(attribute='name') | list == (forge_desired_rules | map(attribute='name') | list)[:forge_existing_rules | length]\n          - forge_existing_rules | map(attribute='metadata.ruleIndex') | list == forge_existing_rules | map(attribute='metadata.ruleIndex') | sort | list\n          - forge_existing_rules | map(attribute='metadata.ruleIndex') | unique | list | length == forge_existing_rules | length\n        fail_msg: Existing rules must be an identical ordered prefix. Removal, renaming, insertion or reordering requires manual review; nothing was changed.\n`)
  const comparisonStart = tasks.length
  tasks.push(`    - name: Reject conflicting existing rule settings before any writes\n      ansible.builtin.assert:\n        that:\n          - item.0.action == item.1.action\n          - item.0.enabled == item.1.enabled\n          - item.0.description | default('') == item.1.description | default('')\n          - item.0.logBegin | default(false) == item.1.logBegin\n          - item.0.logEnd | default(false) == item.1.logEnd\n          - item.0.sendEventsToFMC | default(false) == item.1.sendEventsToFMC\n          - not (item.0.logFiles | default(false))\n          - item.0 | dict2items | rejectattr('key', 'in', forge_rule_fields) | selectattr('value') | list | length == 0\n          - item.0.metadata.ruleIndex is integer\n          - item.0.metadata.ruleIndex > 0\n          - not (item.0.metadata | default({})).get('readOnly', false)\n          - not (item.0.metadata | default({})).get('parentPolicy', {})\n          - not (item.0.metadata | default({})).get('inherited', false)\n          - (item.0.metadata | default({})).get('section', '') == 'Default'\n          - (item.0.metadata | default({})).get('category', '') == '--Undefined--'\n          - not (item.0.variableSet | default({})) or item.0.variableSet.name | default('') == 'Default Set'\n        fail_msg: Existing rule settings differ or include unmanaged conditions; review manually. Nothing was changed.\n      loop: "{{ forge_existing_rules | zip(forge_desired_rules) | list }}"\n      loop_control:\n        label: "{{ item.0.name }}"\n`)
  for (const field of ['sourceNetworks', 'destinationNetworks', 'sourceZones', 'destinationZones', 'destinationPorts']) {
    tasks.push(`    - name: Compare existing ${field} without API display metadata\n      ansible.builtin.assert:\n        that:\n          - (item.0.${field} | default({})).get('objects', []) | map(attribute='id') | sort | list == (item.1.${field} | default({})).get('objects', []) | map(attribute='id') | sort | list\n          - (item.0.${field} | default({})).get('literals', []) == (item.1.${field} | default({})).get('literals', [])\n          - (item.0.${field} | default({})) | dict2items | rejectattr('key', 'in', ['objects', 'literals']) | selectattr('value') | list | length == 0\n        fail_msg: Existing ${field} differs from generated intent; no configuration was changed.\n      loop: "{{ forge_existing_rules | zip(forge_desired_rules) | list }}"\n      loop_control:\n        label: "{{ item.0.name }}"\n`)
  }
  const comparisons = tasks.slice(comparisonStart)
  moduleTask('Create the dedicated BLOCK policy only if absent', 'createAccessPolicy', '        data:\n          name: "{{ forge_policy_name }}"\n          type: AccessPolicy\n          description: "{{ forge_ownership }}"\n          defaultAction:\n            action: BLOCK\n        register_as: forge_created_policy\n', 'forge_policy_matches | length == 0')
  tasks.push(`    - name: Select the guarded policy identity\n      ansible.builtin.set_fact:\n        forge_policy_id: "{{ forge_policy_matches[0].id if forge_policy_matches | length == 1 else forge_created_policy.id }}"\n`)
  moduleTask('Append only missing trailing rules in order (single-object requests)', 'createMultipleAccessRule', '          containerUUID: "{{ forge_policy_id }}"\n        query_params:\n          section: default\n        data: "{{ item }}"\n      loop: "{{ forge_desired_rules[forge_existing_rules | length:] }}"\n      loop_control:\n        label: "{{ item.name }}"\n')
  moduleTask('Read the final policy for ownership and default-action verification', 'getAccessPolicy', '          objectId: "{{ forge_policy_id }}"\n        register_as: forge_existing_policy\n')
  tasks.push(policyGuard
    .replace('Refuse to adopt or modify an unrelated policy', 'Verify final policy ownership and BLOCK default')
    .replace(/      when: .*\n/, '')
    .replace(/fail_msg: .*/, 'fail_msg: Resulting policy settings differ or cannot be verified. Do not assign or deploy; inspect the partial policy manually.'))
  moduleTask('Verify the complete resulting order', 'getAllAccessRule', '          containerUUID: "{{ forge_policy_id }}"\n        query_params:\n          expanded: true\n        filters:\n          type: AccessRule\n        register_as: forge_final_rules\n')
  tasks.push(`    - name: Require exact resulting rule order\n      ansible.builtin.assert:\n        that:\n          - forge_final_rules | map(attribute='name') | list == forge_desired_rules | map(attribute='name') | list\n          - forge_final_rules | map(attribute='metadata.ruleIndex') | list == forge_final_rules | map(attribute='metadata.ruleIndex') | sort | list\n          - forge_final_rules | map(attribute='metadata.ruleIndex') | unique | list | length == forge_final_rules | length\n        fail_msg: FMC returned an unexpected order. Do not assign or deploy this policy; inspect it manually.\n`)

  tasks.push(`    - name: Select the final rules for full intent verification\n      ansible.builtin.set_fact:\n        forge_existing_rules: "{{ forge_final_rules }}"\n`)
  tasks.push(...comparisons.map((task) => task
    .replace('before any writes', 'after writes')
    .replace('Compare existing', 'Verify resulting')
    .replace(/fail_msg: .*/, 'fail_msg: Resulting rule settings differ or cannot be verified. Do not assign or deploy; inspect the partial policy manually.')))

  const policyFields = ['id', 'name', 'type', 'description', 'defaultAction', 'links', 'metadata', 'rules', 'version']
  const ruleFields = ['id', 'name', 'type', 'action', 'enabled', 'description', 'logBegin', 'logEnd', 'sendEventsToFMC', 'logFiles', 'sourceNetworks', 'destinationNetworks', 'sourceZones', 'destinationZones', 'destinationPorts', 'links', 'metadata', 'version', 'commentHistoryList', 'variableSet']
  return `# Requires cisco.fmcansible == 1.1.1 and ansible-core >= 2.16 (traditional FMC HTTPAPI).
# Use a maintained ansible-core/Python combination; >= 2.16 is the collection minimum.
# Install: ansible-galaxy collection install cisco.fmcansible:1.1.1
# External inventory group: fmc; set ansible_host, ansible_user, Vault-protected
# ansible_password and fmc_domain_uuid. Use a dedicated API account and trusted CA.
# Network names refer to existing Network objects only, not Host/NetworkGroup objects.
# IPv4 literals and ICMPv4 only; Any is unrestricted. Direction is not used: set zones.
# A dedicated policy defaults to BLOCK. Existing rules must be an identical prefix;
# edits/deletions/reordering and inherited or advanced policy settings stop for review.
# Not atomic: interrupted creation may leave an undeployed partial policy; rerun safely
# only after checking it. No device assignment, policy deletion or deployment is performed.
# Collection/API availability, response normalization and idempotency need live testing.
---
- name: Configure a guarded dedicated FMC access policy
  hosts: fmc
  connection: ansible.netcommon.httpapi
  gather_facts: false
  serial: 1
  any_errors_fatal: true
  vars:
    ansible_network_os: cisco.fmcansible.fmc
    ansible_httpapi_use_ssl: true
    ansible_httpapi_validate_certs: true
    ansible_httpapi_port: 443
    forge_policy_name: !unsafe ${quoted(policyName)}
    forge_ownership: ${quoted(ownership)}
    forge_policy_fields: ${JSON.stringify(policyFields)}
    forge_rule_fields: ${JSON.stringify(ruleFields)}
    forge_desired_rules: ${yaml(desired, 6)}
  tasks:
${tasks.join('\n')}`.replace(/[ \t]+\n/g, '\n')
}
