import { applyService, baseTarget, blankRule } from './model'
import type { Rule, TargetId } from './model'

export const STARTER_TEMPLATES = [
  { id: 'ssh', icon: 'ssh', title: 'SSH server', description: 'Add one disabled SSH rule to configure in the editor.', services: ['SSH (TCP 22)'] },
  { id: 'web', icon: 'web', title: 'Web server', description: 'Add one disabled HTTPS rule to configure in the editor.', services: ['HTTPS (TCP 443)'] },
  { id: 'dns', icon: 'dns', title: 'DNS server', description: 'Add two disabled DNS rules, one each for UDP and TCP.', services: ['DNS (UDP 53)', 'DNS (TCP 53)'] },
] as const

export type TemplateId = (typeof STARTER_TEMPLATES)[number]['id']
export function createTemplateRules(templateId: TemplateId, target: TargetId, existingRules: readonly Rule[] = []): Rule[] {
  const template = STARTER_TEMPLATES.find((item) => item.id === templateId)
  if (!template) throw new Error('Choose a starter template first.')
  const chain = baseTarget(target) === 'mikrotik' ? 'forward' : 'Auto'
  const services: readonly string[] = template.services
  const names = new Set(existingRules.map((rule) => rule.name))
  return services.map((service) => {
    const configured = applyService(blankRule(), service)
    const baseName = `${template.title} ${configured.protocol} ${configured.ports}`
    let name = baseName
    let suffix = 2
    while (names.has(name)) name = `${baseName} (${suffix++})`
    names.add(name)
    return { ...configured, name, enabled: false, action: 'ALLOW', direction: 'Inbound', routerosChain: chain }
  })
}
