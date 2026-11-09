import type { Rule, TargetId } from './model'
import ButtonIcon from './ButtonIcon'
import { createTemplateRules, STARTER_TEMPLATES } from './templates'
import './Templates.css'

type RuleTemplatesProps = { rules: Rule[]; target: TargetId; onAdd: (added: Rule[], title: string) => void }

export default function RuleTemplates({ rules, target, onAdd }: RuleTemplatesProps) {
  return <details className="template-gallery" open={rules.length === 0}>
    <summary className="template-summary">Starter templates</summary>
    <p className="template-intro">One click adds disabled starter rules. Edit their addresses in the rule table, then enable when ready.</p>
    <div className="template-cards">
      {STARTER_TEMPLATES.map((template) => <button key={template.id} className="template-card" type="button" data-template={template.id} aria-label={`Add ${template.title} starter rules`} onClick={() => onAdd(createTemplateRules(template.id, target, rules), template.title)}>
        <span className="template-card-title"><ButtonIcon name={template.icon} />{template.title}</span>
        <span className="template-card-description">{template.description}</span>
        <span className="template-card-service">{template.services.join(' + ')}</span>
      </button>)}
    </div>
    <p className="template-caveat">Addresses start as Any; rules stay disabled until you enable them. Review source, destination, direction, RouterOS chain, zones/scope and existing policy first. These templates do not add deny-all, NAT, return-traffic, or automatic priority/scope rules.</p>
  </details>
}
