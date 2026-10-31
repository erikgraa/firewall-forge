import { SERVICES, applyService, blankRule, CUSTOM } from './model'
import type { Action, Direction, Protocol, Rule } from './model'

const protocols: Protocol[] = ['TCP', 'UDP', 'ICMP', 'ANY']

// Columns: name, source, destination, service-or-protocol, ports, action, direction
export const parseCsv = (text: string): Rule[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^name\s*[,;\t]/i.test(l))
    .map((line) => {
      const [name = '', source = 'Any', destination = 'Any', svc = '', ports = '', action = 'ALLOW', direction = 'Inbound'] = line
        .split(/\t|;|,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
        .map((c) => c.trim().replace(/^"|"$/g, ''))
      const rule: Rule = { ...blankRule(), name, source, destination }
      const act = action.toUpperCase()
      rule.action = (['ALLOW', 'DROP', 'REJECT'].includes(act) ? act : 'ALLOW') as Action
      rule.direction = (/^out/i.test(direction) ? 'Outbound' : 'Inbound') as Direction
      if (SERVICES[svc]) return applyService(rule, svc)
      const proto = svc.toUpperCase() as Protocol
      return { ...rule, service: CUSTOM, protocol: protocols.includes(proto) ? proto : 'ANY', ports }
    })
