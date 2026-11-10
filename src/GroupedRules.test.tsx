import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { isValidElement } from 'react'
import type { DragEvent, ReactElement, ReactNode } from 'react'
import { moveRuleToSection, reorderRuleWithinSection } from './sectionMoves'
import GroupedRules from './GroupedRules'
import { blankRule } from './model'
import type { Membership, RuleEntry } from './grouping'
import type { Rule } from './model'

const mode = vi.hoisted(() => ({ sections: false, interaction: false, cursor: 0, refCursor: 0, states: [] as unknown[], refs: [] as { current: unknown }[], effects: [] as (() => void)[], layouts: [] as (() => void)[] }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) => {
      const value = mode.sections && initial === true ? false : initial
      if (!mode.interaction) return actual.useState(value)
      const index = mode.cursor++
      if (!(index in mode.states)) mode.states[index] = typeof value === 'function' ? value() : value
      return [mode.states[index], (next: unknown) => { mode.states[index] = typeof next === 'function' ? next(mode.states[index]) : next }]
    },
    useRef: (initial: unknown) => {
      if (!mode.interaction) return actual.useRef(initial)
      const index = mode.refCursor++
      return mode.refs[index] ??= { current: initial }
    },
    useEffect: (effect: () => void, deps: unknown[]) => mode.interaction ? mode.effects.push(effect) : actual.useEffect(effect, deps),
    useLayoutEffect: (effect: () => void, deps: unknown[]) => mode.interaction ? mode.layouts.push(effect) : actual.useLayoutEffect(effect, deps),
  }
})
afterEach(() => { mode.sections = false; mode.interaction = false; mode.states = []; mode.refs = []; mode.effects = []; mode.layouts = []; mode.cursor = 0; mode.refCursor = 0; vi.unstubAllGlobals() })
const rules = [
  { ...blankRule(), id: 'first', name: 'same name' },
  { ...blankRule(), id: 'second', name: '', enabled: false },
  { ...blankRule(), id: 'third', name: 'same name' },
]
const render = (input: Rule[] = rules, membership: Membership = { first: 'a', third: 'a' }, titles: Record<string, string> = { a: 'Application', empty: 'Empty named section' }, onMove = vi.fn<(ruleId: string, groupId: string) => void>(), onAdd = vi.fn<(groupId: string) => void>(), onReorder = vi.fn<(ruleId: string, anchorId: string, placement: 'before' | 'after') => void>()) => {
  const children = vi.fn((entries: RuleEntry[], controls?: (entry: RuleEntry) => ReactNode) => <table><thead><tr><th>Rule</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.rule.id} data-rule-id={entry.rule.id}><td>{entry.index + 1} · {entry.rule.name || '(unnamed)'}{controls?.(entry)}</td></tr>)}</tbody></table>)
  const markup = renderToStaticMarkup(<GroupedRules rules={input} membership={membership} titles={titles} setTitles={vi.fn()} onMove={onMove} onAdd={onAdd} onReorder={onReorder}>{children}</GroupedRules>)
  return { markup, children }
}

describe('flat-first section prototype', () => {
  it.each([false, true])('shows the experimental warning only when Sections is selected (%s)', (sections) => {
    mode.sections = sections
    const { markup } = render()
    expect(markup.includes('Experimental rule sections')).toBe(sections)
    expect(markup.includes('class="preview-notice"')).toBe(sections)
    if (sections) {
      expect(markup).toContain('saved in this browser and included in JSON / share links')
      expect(markup).toContain('CSV remains rule-only.')
      expect(markup).not.toMatch(/temporary|reset on reload/)
      expect(markup).toContain('Dragging or using Move changes actual evaluation order.')
      expect(markup).toContain('Separate NSX policy output affects deployment and requires review.')
      expect(markup.indexOf('Experimental rule sections')).toBeGreaterThan(markup.indexOf('Rule organization'))
    }
  })

  it('defaults to flat list with explicit pressed controls and renders the real global order once', () => {
    const { markup, children } = render()
    expect(markup).toContain('aria-pressed="true">Flat list</button>')
    expect(markup).toContain('aria-pressed="false">Sections</button>')
    expect(children).toHaveBeenCalledTimes(1)
    expect(children.mock.calls[0][0].map(({ rule, index }) => [rule.id, index])).toEqual([['first', 0], ['second', 1], ['third', 2]])
    expect(children.mock.calls[0]).toHaveLength(1)
    expect(markup.match(/<table>/g)).toHaveLength(1)
    expect(markup).not.toContain('draggable=')
    expect(markup).not.toContain('Move to section')
    expect(markup).not.toContain('section-builder')
    expect(markup).not.toContain('Start at rule')
    expect(markup).not.toContain('Merge with previous')
  })
  it('shows the existing empty message in flat mode without an empty table', () => {
    const { markup, children } = render([])
    expect(markup).toContain('No rules yet. Choose a starter template above, add a rule, or import a CSV / JSON file.')
    expect(children).not.toHaveBeenCalled()
  })
  it('permits named section creation and retains empty Unsectioned even with zero rules', () => {
    mode.sections = true
    const { markup } = render([])
    expect(markup).toContain('aria-label="New section name"')
    expect(markup).toContain('disabled="">Create section</button>')
    expect(markup).toContain('data-section-id="unsectioned"')
    expect(markup).toContain('Unsectioned')
    expect(markup).toContain('Empty named section')
    expect(markup).toContain('Empty · drop here')
    expect(markup).not.toContain('Start at rule')
    expect(markup).not.toContain('Merge with previous')
  })
  it('renders continued runs in actual global positions with a single table per populated run', () => {
    mode.sections = true
    const { markup, children } = render()
    expect(children).toHaveBeenCalledTimes(3)
    expect(children.mock.calls.map(([entries]) => entries.map(({ index }) => index))).toEqual([[0], [1], [2]])
    expect(children.mock.calls.every((call) => typeof call[1] === 'function')).toBe(true)
    expect(markup).toContain('Application (continued)')
    expect(markup).toContain('Rules 3–3')
    expect(markup.match(/<table>/g)).toHaveLength(3)
    expect(markup.match(/data-move-rule-id=/g)).toHaveLength(3)
    expect(markup).toContain('Drag rule 1 (same name) to a section; changes evaluation order')
    expect(markup).toContain('Drag rule 3 (same name) to a section; changes evaluation order')
    expect(markup).toContain('Move rule 2 (unnamed) to section; changes evaluation order')
    expect(markup).toContain('value="unsectioned"')
    expect(markup).toContain('changes evaluation order, not just labels')
    expect(markup).toContain('aria-live="polite"')
  })
  it('does not trust inherited membership or titles and keeps the Unsectioned name reserved', () => {
    mode.sections = true
    const { markup } = render(rules, Object.create({ first: 'inherited' }), { ...Object.create({ inherited: 'Inherited title' }), unsectioned: 'Do not rename', a: 'Named' })
    expect(markup).not.toContain('Inherited title')
    expect(markup).not.toContain('Do not rename')
    expect(markup).toContain('Unsectioned')
    expect(markup).not.toContain('Section name for Unsectioned')
  })

  it('places the flat Add rule footer after the table, including the empty workspace', () => {
    const { markup } = render()
    expect(markup.indexOf('rule-add-footer')).toBeGreaterThan(markup.indexOf('</table>'))
    expect(markup.match(/class="rule-add-footer"/g)).toHaveLength(1)
    expect(markup).toContain('Add rule</button>')
    expect(render([]).markup).toContain('Add rule</button>')
  })

  it('offers Add rule after each populated or empty section body', () => {
    mode.sections = true
    const { markup } = render()
    expect(markup.match(/class="rule-add-footer"/g)).toHaveLength(4)
    expect(markup).toContain('aria-label="Add rule to Unsectioned"')
    expect(markup).toContain('aria-label="Add rule to Empty named section"')
    expect(markup).toContain('aria-label="Add rule to Application"')
  })

  it('routes flat and per-section Add rule buttons by stable group ID', () => {
    mode.interaction = true
    const onAdd = vi.fn()
    const findAddButtons = (node: ReactNode): { onClick: () => void; 'aria-label'?: string }[] => {
      if (Array.isArray(node)) return node.flatMap(findAddButtons)
      if (!isValidElement<{ children?: ReactNode; onClick: () => void; className?: string; 'aria-label'?: string }>(node)) return []
      if (node.type === 'button' && node.props.className?.includes('add-action')) return [node.props]
      return findAddButtons(node.props.children)
    }
    const props = { rules: [], membership: {}, titles: { empty: 'Named empty' }, setTitles: vi.fn(), onMove: vi.fn(), onAdd, onReorder: vi.fn(), children: () => null }
    findAddButtons(GroupedRules(props))[0].onClick()
    expect(onAdd).toHaveBeenLastCalledWith('unsectioned')
    mode.sections = true; mode.states = []; mode.cursor = 0; mode.refCursor = 0
    const sectionButtons = findAddButtons(GroupedRules(props))
    expect(sectionButtons).toHaveLength(2)
    sectionButtons.find((button) => button['aria-label'] === 'Add rule to Named empty')!.onClick()
    expect(onAdd).toHaveBeenLastCalledWith('empty')
    sectionButtons.find((button) => button['aria-label'] === 'Add rule to Unsectioned')!.onClick()
    expect(onAdd).toHaveBeenLastCalledWith('unsectioned')
  })

  it('restores Move-select focus after the destination expansion commit, without a frame race', () => {
    mode.sections = true
    mode.interaction = true
    let currentRules = rules
    let currentMembership: Membership = { first: 'a', third: 'a' }
    const onMove = vi.fn((ruleId: string, groupId: string) => {
      const moved = moveRuleToSection(currentRules, currentMembership, ruleId, groupId)
      currentRules = moved.rules
      currentMembership = moved.membership
    })
    const destination = { open: false }
    let focused = false
    const select = { focus: vi.fn(() => { if (destination.open) focused = true }) }
    const controls = { dataset: { moveRuleId: 'first' }, querySelector: () => select, closest: () => destination }
    const frame = vi.fn((callback: () => void) => callback())
    vi.stubGlobal('requestAnimationFrame', frame)
    const commit = () => {
      mode.cursor = 0; mode.refCursor = 0; mode.effects = []; mode.layouts = []
      const result = render(currentRules, currentMembership, undefined, onMove)
      destination.open = (mode.states[1] as Set<string>).has('second')
      mode.layouts.forEach((effect) => effect())
      return result
    }
    const initial = commit()
    mode.refs[0].current = { querySelectorAll: () => [controls] }
    const renderedControls = initial.children.mock.calls[0][1]!({ rule: rules[0], index: 0 })
    expect(isValidElement<{ children: ReactNode[] }>(renderedControls)).toBe(true)
    if (!isValidElement<{ children: ReactNode[] }>(renderedControls)) throw new Error('Missing rule controls')
    const label = renderedControls.props.children[2]
    if (!isValidElement<{ children: ReactNode[] }>(label)) throw new Error('Missing Move label')
    const menu = label.props.children[1]
    if (!isValidElement<{ onChange: (event: { target: { value: string } }) => void }>(menu)) throw new Error('Missing Move select')
    menu.props.onChange({ target: { value: 'unsectioned' } })
    commit()
    mode.effects.forEach((effect) => effect())
    expect(focused).toBe(false)
    commit()
    expect(destination.open).toBe(true)
    expect(focused).toBe(true)
    expect(select.focus).toHaveBeenCalledTimes(1)
    expect(frame).not.toHaveBeenCalled()
    expect(onMove).toHaveBeenCalledWith('first', 'unsectioned')
    expect(mode.states[4]).toContain('global evaluation position is now 2')
  })
})

type UIProps = {
  children?: ReactNode; onClick?: () => void; disabled?: boolean; draggable?: boolean
  onDragStart?: (event: DragEvent) => void
  onDragOver?: (event: DragEvent<HTMLDetailsElement>) => void
  onDrop?: (event: DragEvent<HTMLDetailsElement>) => void
  'data-rule-reorder'?: string; 'data-section-id'?: string; 'data-move-rule-id'?: string
}
const elements = (node: ReactNode, type: string): ReactElement<UIProps>[] => {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child, type))
  if (!isValidElement<UIProps>(node)) return []
  return [...(node.type === type ? [node] : []), ...elements(node.props.children, type)]
}
const interactionTree = (membership: Membership = { first: 'a', second: 'a', third: 'a' }) => {
  mode.sections = true; mode.interaction = true
  const onMove = vi.fn(), onReorder = vi.fn()
  const tree = GroupedRules({ rules, membership, titles: { a: 'Servers', b: 'Other' }, setTitles: vi.fn(), onMove, onReorder, onAdd: vi.fn(), children: (entries, controls) => entries.map((entry) => <div key={entry.rule.id} data-table-rule-id={entry.rule.id}>{controls?.(entry)}</div>) })
  return { tree, onMove, onReorder }
}
const dragEvent = (anchorId: string | null, payload = 'first', types = ['application/x-firewall-forge-rule'], clientY = 101) => {
  const row = { dataset: { tableRuleId: anchorId }, getBoundingClientRect: () => ({ top: 100, height: 40 }) }
  const event = {
    target: { closest: () => anchorId ? row : null }, currentTarget: { contains: () => true }, clientY,
    dataTransfer: { types, getData: () => payload, setData: vi.fn(), effectAllowed: '', dropEffect: '' },
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
  }
  return { event: event as unknown as DragEvent<HTMLDetailsElement>, preventDefault: event.preventDefault, stopPropagation: event.stopPropagation }
}

describe('section-local ordering controls', () => {
  it('targets immediate neighbors and disables both ends without crossing continued runs', () => {
    const { tree, onReorder } = interactionTree()
    const controls = elements(tree, 'div').filter((element) => element.props['data-move-rule-id'])
    const first = elements(controls[0], 'button').filter((element) => element.props['data-rule-reorder'])
    const middle = elements(controls[1], 'button').filter((element) => element.props['data-rule-reorder'])
    const last = elements(controls[2], 'button').filter((element) => element.props['data-rule-reorder'])
    expect(first.map((button) => button.props.disabled)).toEqual([true, false])
    expect(middle.map((button) => button.props.disabled)).toEqual([false, false])
    expect(last.map((button) => button.props.disabled)).toEqual([false, true])
    middle[0].props.onClick!()
    expect(onReorder).toHaveBeenLastCalledWith('second', 'first', 'before')
    middle[1].props.onClick!()
    expect(onReorder).toHaveBeenLastCalledWith('second', 'third', 'after')
    mode.states = []; mode.cursor = 0; mode.refCursor = 0
    const continued = interactionTree({ first: 'a', second: 'b', third: 'a' })
    const arrows = elements(continued.tree, 'button').filter((button) => button.props['data-rule-reorder'])
    expect(arrows.every((button) => button.props.disabled)).toBe(true)
  })

  it.each([[101, 'before'], [139, 'after']] as const)('places internal row drops at midpoint Y=%s (%s) and prevents section-end bubbling', (clientY, placement) => {
    const { tree, onMove, onReorder } = interactionTree()
    const handle = elements(tree, 'button').find((button) => button.props.draggable)!
    const section = elements(tree, 'details').find((detail) => detail.props['data-section-id'] === 'a')!
    handle.props.onDragStart!(dragEvent(null).event)
    const drop = dragEvent('third', 'first', undefined, clientY)
    section.props.onDragOver!(drop.event)
    expect(mode.states[6]).toEqual({ anchorId: 'third', placement })
    section.props.onDrop!(drop.event)
    expect(onReorder).toHaveBeenCalledWith('first', 'third', placement)
    expect(onMove).not.toHaveBeenCalled()
    expect(drop.stopPropagation).toHaveBeenCalled()
    expect(drop.preventDefault).toHaveBeenCalled()
  })

  it('rejects spoofed/foreign payloads and cross-group or continued-run row drops', () => {
    const { tree, onMove, onReorder } = interactionTree()
    const section = elements(tree, 'details').find((detail) => detail.props['data-section-id'] === 'a')!
    section.props.onDrop!(dragEvent('third').event)
    expect(onReorder).not.toHaveBeenCalled()
    const handle = elements(tree, 'button').find((button) => button.props.draggable)!
    handle.props.onDragStart!(dragEvent(null).event)
    section.props.onDrop!(dragEvent('third', 'first', ['text/plain']).event)
    section.props.onDrop!(dragEvent('third', 'forged-id').event)
    expect(onReorder).not.toHaveBeenCalled()
    expect(onMove).not.toHaveBeenCalled()
    for (const membership of [{ first: 'a', second: 'b', third: 'b' }, { first: 'a', second: 'b', third: 'a' }]) {
      mode.states = []; mode.refs = []; mode.cursor = 0; mode.refCursor = 0
      const other = interactionTree(membership)
      elements(other.tree, 'button').find((button) => button.props.draggable)!.props.onDragStart!(dragEvent(null).event)
      const target = elements(other.tree, 'details').at(-1)!
      target.props.onDrop!(dragEvent('third').event)
      expect(other.onMove).not.toHaveBeenCalled()
      expect(other.onReorder).not.toHaveBeenCalled()
    }
  })

  it('keeps cross-section header drops using the original Move callback', () => {
    const { tree, onMove, onReorder } = interactionTree()
    elements(tree, 'button').find((button) => button.props.draggable)!.props.onDragStart!(dragEvent(null).event)
    const target = elements(tree, 'details').find((detail) => detail.props['data-section-id'] === 'b')!
    target.props.onDrop!(dragEvent(null).event)
    expect(onMove).toHaveBeenCalledWith('first', 'b')
    expect(onReorder).not.toHaveBeenCalled()
  })

  it.each([['first', 'down', 'down'], ['second', 'up', 'down']] as const)('restores an enabled local arrow after moving %s %s (focus %s)', (ruleId, direction, expectedFocus) => {
    mode.sections = true; mode.interaction = true
    let currentRules = rules
    const membership = { first: 'a', second: 'a', third: 'a' }
    const onReorder = vi.fn((source: string, anchor: string, placement: 'before' | 'after') => { currentRules = reorderRuleWithinSection(currentRules, membership, source, anchor, placement).rules })
    const focused = vi.fn()
    const details = { open: false }
    const controls = {
      dataset: { moveRuleId: ruleId }, closest: () => details,
      querySelector: (selector: string) => {
        const index = currentRules.findIndex((rule) => rule.id === ruleId)
        if (selector.includes(`="${direction}"`) && ((direction === 'up' && index === 0) || (direction === 'down' && index === currentRules.length - 1))) return null
        return { focus: () => { if (details.open) focused(selector) } }
      },
    }
    const commit = () => {
      mode.cursor = 0; mode.refCursor = 0; mode.effects = []; mode.layouts = []
      const result = render(currentRules, membership, undefined, undefined, undefined, onReorder)
      details.open = (mode.states[1] as Set<string>).has(currentRules[0].id)
      mode.layouts.forEach((effect) => effect())
      return result
    }
    const initial = commit()
    mode.refs[0].current = { querySelectorAll: () => [controls] }
    const entry = { rule: rules.find((rule) => rule.id === ruleId)!, index: rules.findIndex((rule) => rule.id === ruleId) }
    const rowControls = initial.children.mock.calls[0][1]!(entry)
    elements(rowControls, 'button').find((button) => button.props['data-rule-reorder'] === direction)!.props.onClick!()
    commit(); mode.effects.forEach((effect) => effect()); commit()
    expect(focused).toHaveBeenCalledTimes(1)
    const selector = focused.mock.calls[0][0] as string
    expect(selector).toContain(':not(:disabled)')
    expect(selector).toContain('data-rule-reorder')
    if (ruleId === 'first') expect(selector).toContain(`="${expectedFocus}"`)
    else expect(selector).toBe('[data-rule-reorder]:not(:disabled)')
    expect(mode.states[4]).toContain('within Application')
    expect(mode.states[4]).toContain(`global evaluation position is now ${currentRules.findIndex((rule) => rule.id === ruleId) + 1}`)
  })
})
