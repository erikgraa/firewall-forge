import { afterEach, describe, expect, it, vi } from 'vitest'
import { isValidElement } from 'react'
import type { ChangeEvent, ComponentProps, ReactElement, ReactNode } from 'react'
import App from './App'
import GroupedRules from './GroupedRules'
import RuleTemplates from './RuleTemplates'
import Topology from './TopologyView'
import { blankRule } from './model'
import { createTemplateRules, STARTER_TEMPLATES } from './templates'

const hooks = vi.hoisted(() => ({ cursor: 0, states: [] as unknown[] }))
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useMemo: (calculate: () => unknown) => calculate(),
  useEffect: () => {},
  useState: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? initial() : initial
    return [hooks.states[index], (next: unknown) => {
      hooks.states[index] = typeof next === 'function' ? next(hooks.states[index]) : next
    }]
  },
}))
afterEach(() => { hooks.cursor = 0; hooks.states = []; vi.unstubAllGlobals() })

const render = () => { hooks.cursor = 0; return App() }
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children as ReactNode)]
}
const grouped = (tree: ReactNode) => elements(tree).find((node) => node.type === GroupedRules)!.props as ComponentProps<typeof GroupedRules>
const notice = (tree: ReactNode) => elements(tree).find((node) => node.type === 'p' && node.props.role === 'status')?.props.children
function setup() {
  const existing = { ...blankRule(), id: 'existing', name: 'existing' }
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'fwgen.theme' ? 'light' : key === 'fwgen.v2' ? JSON.stringify({ rules: [existing], target: 'windows', policyName: 'test' }) : null })
  return render()
}
function add(tree: ReactNode, template: typeof STARTER_TEMPLATES[number]) {
  const props = elements(tree).find((node) => node.type === RuleTemplates)!.props as ComponentProps<typeof RuleTemplates>
  const added = createTemplateRules(template.id, props.target, props.rules)
  props.onAdd(added, template.title)
  return added
}
function editAddress(tree: ReactNode, id: string, field: 'source' | 'destination', value: string) {
  const props = grouped(tree)
  const table = props.children(props.rules.map((rule, index) => ({ rule, index })))
  const row = elements(table).find((node) => node.props['data-table-rule-id'] === id)!
  const inputs = elements(row).filter((node) => node.type === 'input' && node.props.list === 'endpoints')
  const onChange = inputs[field === 'source' ? 0 : 1].props.onChange as (event: ChangeEvent<HTMLInputElement>) => void
  onChange({ target: { value } } as ChangeEvent<HTMLInputElement>)
}

describe.each(STARTER_TEMPLATES)('$title confirmation notice', (template) => {
  it.each(['source', 'destination'] as const)('disappears after editing a starter %s without enabling or deleting rules', (field) => {
    const added = add(setup(), template)
    let tree = render()
    expect(notice(tree)).toContain(`${template.title}: added ${added.length} disabled rule`)
    editAddress(tree, added[added.length - 1].id, field, '10.20.0.0/24')
    tree = render()
    expect(notice(tree)).toBeUndefined()
    expect(grouped(tree).rules).toHaveLength(1 + added.length)
    expect(grouped(tree).rules.find((rule) => rule.id === added[added.length - 1].id)).toMatchObject({ [field]: '10.20.0.0/24', enabled: false })
    expect(grouped(tree).rules.filter((rule) => added.some((starter) => starter.id === rule.id)).every((rule) => !rule.enabled)).toBe(true)
  })

  it('keeps the notice for unrelated edits and unchanged endpoints, and shows a fresh notice on the next addition', () => {
    const added = add(setup(), template)
    let tree = render()
    editAddress(tree, 'existing', 'source', '10.90.0.0/24')
    tree = render()
    expect(notice(tree)).toContain(template.title)
    editAddress(tree, added[0].id, 'source', 'Any')
    tree = render()
    expect(notice(tree)).toContain(template.title)
    const next = add(tree, template)
    tree = render()
    editAddress(tree, added[0].id, 'destination', '10.30.0.10')
    tree = render()
    expect(notice(tree)).toContain(template.title)
    editAddress(tree, next[0].id, 'destination', '10.30.0.20')
    expect(notice(render())).toBeUndefined()
  })

  it('also dismisses the notice when a starter endpoint is edited in Topology', () => {
    const added = add(setup(), template)
    let tree = render()
    const tab = elements(tree).find((node) => node.props.id === 'topology-view-tab')!
    ;(tab.props.onClick as () => void)()
    tree = render()
    const topology = elements(tree).find((node) => node.type === Topology)!
    const onPatch = topology.props.onPatch as ComponentProps<typeof Topology>['onPatch']
    onPatch(added[0].id, { destination: '10.30.0.10' })
    expect(notice(render())).toBeUndefined()
  })
})
