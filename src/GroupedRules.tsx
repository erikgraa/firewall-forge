import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Dispatch, DragEvent, ReactNode, SetStateAction } from 'react'
import { newId } from './model'
import type { Rule } from './model'
import { sectionRuns } from './grouping'
import { reorderRuleWithinSection } from './sectionMoves'
import type { Membership, RuleEntry } from './grouping'
import ButtonIcon from './ButtonIcon'
import './Grouping.css'

const RULE_MIME = 'application/x-firewall-forge-rule'
const emptyMessage = 'No rules yet. Choose a starter template above, add a rule, or import a CSV / JSON file.'

export default function GroupedRules({ rules, children, membership, titles, setTitles, onMove, onAdd, onReorder }: {
  rules: Rule[]; children: (entries: RuleEntry[], controls?: (entry: RuleEntry) => ReactNode) => ReactNode
  membership: Membership
  titles: Record<string, string>; setTitles: Dispatch<SetStateAction<Record<string, string>>>
  onMove: (ruleId: string, groupId: string) => void
  onAdd: (groupId: string) => void
  onReorder: (ruleId: string, anchorId: string, placement: 'before' | 'after') => void
}) {
  const [flat, setFlat] = useState(true)
  const [expanded, setExpanded] = useState(() => new Set<string>())
  const [newTitle, setNewTitle] = useState('')
  const [dropTarget, setDropTarget] = useState('')
  const [feedback, setFeedback] = useState('')
  const [focusRuleId, setFocusRuleId] = useState('')
  const [rowDrop, setRowDrop] = useState<{ anchorId: string; placement: 'before' | 'after' } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const draggedId = useRef('')
  const focusControl = useRef('select')
  const pendingMove = useRef<{ ruleId: string; groupId: string; destination: string; restoreFocus: boolean; reorder?: boolean } | null>(null)
  // sectionRuns intentionally preserves disjoint runs; normalize only inherited metadata.
  const safeMembership = Object.fromEntries(rules.map((rule) => [rule.id, Object.hasOwn(membership, rule.id) ? membership[rule.id] ?? 'unsectioned' : 'unsectioned']))
  const runs = sectionRuns(rules, safeMembership)
  const groups = [...new Set(['unsectioned', ...Object.keys(titles), ...runs.map((run) => run.group)])]
  const sections = [...runs, ...groups.filter((group) => !runs.some((run) => run.group === group)).map((group) => ({ key: `empty:${group}`, group, continued: false, entries: [] as RuleEntry[] }))]
  const titleOf = (group: string) => group === 'unsectioned' ? 'Unsectioned' : (Object.hasOwn(titles, group) && titles[group].trim()) || 'Untitled section'
  useEffect(() => {
    const move = pendingMove.current
    if (!move) return
    const index = rules.findIndex((rule) => rule.id === move.ruleId)
    const group = Object.hasOwn(membership, move.ruleId) ? membership[move.ruleId] : 'unsectioned'
    if (index >= 0 && group === move.groupId) {
      setFeedback(`Moved rule ${index + 1} (${rules[index].name || 'unnamed'}) ${move.reorder ? 'within' : 'to'} ${move.destination}. Its global evaluation position is now ${index + 1}.`)
      pendingMove.current = null
      if (move.restoreFocus || move.reorder) {
        let start = index
        while (start > 0 && (Object.hasOwn(membership, rules[start - 1].id) ? membership[rules[start - 1].id] : 'unsectioned') === move.groupId) start--
        setExpanded((current) => new Set([...current, rules[start].id]))
        if (move.restoreFocus) setFocusRuleId(move.ruleId)
      }
    }
  }, [rules, membership])
  useLayoutEffect(() => {
    if (!focusRuleId || flat) return
    const controls = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-move-rule-id]') ?? []).find((element) => element.dataset.moveRuleId === focusRuleId)
    const select = (focusControl.current !== 'select' ? controls?.querySelector<HTMLElement>(`[data-rule-reorder="${focusControl.current}"]:not(:disabled)`) ?? controls?.querySelector<HTMLElement>('[data-rule-reorder]:not(:disabled)') : null) ?? controls?.querySelector<HTMLSelectElement>('select')
    // Focus only after React commits the destination's expanded, remounted row.
    if (select && controls?.closest('details')?.open) {
      select.focus()
      setFocusRuleId('')
    }
  }, [focusRuleId, flat, expanded, rules])
  const moveRule = (ruleId: string, groupId: string, restoreFocus = false) => {
    const index = rules.findIndex((rule) => rule.id === ruleId)
    if (index < 0 || !groups.includes(groupId)) return
    const destination = titleOf(groupId)
    focusControl.current = 'select'
    pendingMove.current = { ruleId, groupId, destination, restoreFocus }
    setFeedback(`Moving rule ${index + 1} (${rules[index].name || 'unnamed'}) to ${destination} changes evaluation order.`)
    onMove(ruleId, groupId)
  }
  const reorderRule = (ruleId: string, anchorId: string, placement: 'before' | 'after', keyboard = false) => {
    const result = reorderRuleWithinSection(rules, membership, ruleId, anchorId, placement)
    if (result.fromIndex < 0 || result.fromIndex === result.toIndex) return
    const groupId = safeMembership[ruleId]
    const destination = titleOf(groupId)
    focusControl.current = keyboard ? (placement === 'before' ? 'up' : 'down') : 'select'
    pendingMove.current = { ruleId, groupId, destination, restoreFocus: keyboard, reorder: true }
    setFeedback(`Reordering rule ${result.fromIndex + 1} within ${destination} changes evaluation order.`)
    onReorder(ruleId, anchorId, placement)
  }
  useLayoutEffect(() => {
    if (!rowDrop || flat) return
    const row = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-table-rule-id], [data-move-rule-id]') ?? []).find((element) => (element.dataset.tableRuleId ?? element.dataset.moveRuleId) === rowDrop.anchorId)
    row?.setAttribute('data-reorder-placement', rowDrop.placement)
    return () => row?.removeAttribute('data-reorder-placement')
  }, [rowDrop, flat, rules])
  const internalDrag = (event: DragEvent) => draggedId.current && rules.some((rule) => rule.id === draggedId.current) && Array.from(event.dataTransfer.types).includes(RULE_MIME)
  const rowFor = (event: DragEvent<HTMLDetailsElement>) => {
    const target = event.target as Element
    const row = target.closest?.<HTMLElement>('[data-table-rule-id]') ?? target.closest?.<HTMLElement>('[data-move-rule-id]')
    return row && event.currentTarget.contains(row) ? row : null
  }
  const anchorOf = (row: HTMLElement) => row.dataset.tableRuleId ?? row.dataset.moveRuleId ?? ''
  const sameRun = (ruleId: string, anchorId: string) => ruleId !== anchorId && runs.some((run) => run.entries.some(({ rule }) => rule.id === ruleId) && run.entries.some(({ rule }) => rule.id === anchorId))
  const placementFor = (event: DragEvent, row: HTMLElement): 'before' | 'after' => {
    const bounds = row.getBoundingClientRect()
    return event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
  }
  const handleDragOver = (event: DragEvent<HTMLDetailsElement>, sectionKey: string) => {
    if (!internalDrag(event)) return
    const row = rowFor(event)
    if (row) {
      event.stopPropagation()
      setDropTarget('')
      if (!sameRun(draggedId.current, anchorOf(row))) { setRowDrop(null); return }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      const anchorId = anchorOf(row)
      const placement = placementFor(event, row)
      setRowDrop((current) => current?.anchorId === anchorId && current.placement === placement ? current : { anchorId, placement })
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setRowDrop(null)
    setDropTarget(sectionKey)
  }
  const handleDrop = (event: DragEvent<HTMLDetailsElement>, groupId: string) => {
    if (!internalDrag(event)) return
    const row = rowFor(event)
    event.preventDefault()
    event.stopPropagation()
    const ruleId = event.dataTransfer.getData(RULE_MIME)
    if (ruleId === draggedId.current) {
      if (row) {
        if (sameRun(ruleId, anchorOf(row))) reorderRule(ruleId, anchorOf(row), placementFor(event, row))
      } else moveRule(ruleId, groupId)
    }
    draggedId.current = ''; setDropTarget(''); setRowDrop(null)
  }
  const createSection = () => {
    const name = newTitle.trim()
    if (!name) return
    const group = newId()
    setTitles((current) => ({ ...current, [group]: name }))
    setExpanded((current) => new Set([...current, `empty:${group}`]))
    setNewTitle('')
    setFeedback(`Created empty section ${name}. Move rules into it to change their evaluation order.`)
  }
  const renderRuleControls = ({ rule, index }: RuleEntry) => {
    const label = `rule ${index + 1} (${rule.name || 'unnamed'})`
    const run = runs.find((candidate) => candidate.entries.some((entry) => entry.rule.id === rule.id))
    const localIndex = run?.entries.findIndex((entry) => entry.rule.id === rule.id) ?? -1
    const previous = run?.entries[localIndex - 1]?.rule
    const next = run?.entries[localIndex + 1]?.rule
    const sectionLabel = `${titleOf(safeMembership[rule.id])}${run?.continued ? ' (continued)' : ''}`
    return <div className="section-rule-controls" data-move-rule-id={rule.id}>
      <button type="button" className="rule-drag-handle" draggable aria-label={`Drag ${label} to a section; changes evaluation order`} aria-describedby="section-move-hint" title="Drag above/below a row in this section, or onto another section header; use arrows or Move for keyboard/touch"
        onDragStart={(event) => { draggedId.current = rule.id; event.dataTransfer.setData(RULE_MIME, rule.id); event.dataTransfer.effectAllowed = 'move' }}
        onDragEnd={() => { draggedId.current = ''; setDropTarget(''); setRowDrop(null) }}><span aria-hidden="true">⠿</span></button>
      <span className="section-reorder-buttons">
        <button type="button" className="ghost" data-rule-reorder="up" disabled={!previous} aria-label={`Move ${label} up within ${sectionLabel}; changes evaluation order`} onClick={() => { if (previous) reorderRule(rule.id, previous.id, 'before', true) }}>↑</button>
        <button type="button" className="ghost" data-rule-reorder="down" disabled={!next} aria-label={`Move ${label} down within ${sectionLabel}; changes evaluation order`} onClick={() => { if (next) reorderRule(rule.id, next.id, 'after', true) }}>↓</button>
      </span>
      <label>Move to section<select aria-label={`Move ${label} to section; changes evaluation order`} aria-describedby="section-move-hint" value={safeMembership[rule.id]} onChange={(event) => moveRule(rule.id, event.target.value, true)}>{groups.map((group, groupIndex) => <option key={group} value={group}>{titleOf(group)}{groups.filter((candidate) => titleOf(candidate) === titleOf(group)).length > 1 ? ` (section ${groupIndex + 1})` : ''}</option>)}</select></label>
    </div>
  }
  return <div className="grouping-preview" ref={root}>
    <div className="grouping-toolbar">
      <div><strong>Rule organization</strong><span>{rules.length} rules · global evaluation order</span></div>
      <div className="grouping-actions" role="group" aria-label="Rule list presentation">
        <button type="button" className="ghost" aria-pressed={flat} onClick={() => setFlat(true)}>Flat list</button>
        <button type="button" className="ghost" aria-pressed={!flat} onClick={() => setFlat(false)}>Sections</button>
      </div>
    </div>
    <p className="section-feedback" role="status" aria-live="polite" aria-atomic="true">{feedback}</p>
    {flat ? <>
      {rules.length ? children(rules.map((rule, index) => ({ rule, index }))) : <p className="empty-state">{emptyMessage}</p>}
      <div className="rule-add-footer"><button type="button" className="ghost action-button add-action" onClick={() => onAdd('unsectioned')}><ButtonIcon name="add" />Add rule</button></div>
    </> : <>
      <aside className="preview-notice"><strong>Experimental rule sections</strong><p>Flat list is the default. Named sections are temporary: labels and membership reset on reload and are not saved in CSV / JSON or share links. Dragging or using Move changes actual evaluation order. Within a section, drag above or below another rule or use its up/down buttons; section boundaries stay intact. Separate NSX policy output affects deployment and requires review.</p></aside>
      <form className="section-builder" onSubmit={(event) => { event.preventDefault(); createSection() }}>
        <label>New section name<input aria-label="New section name" value={newTitle} placeholder="e.g. Internet access" onChange={(event) => setNewTitle(event.target.value)} /></label>
        <button className="ghost" disabled={!newTitle.trim()}>Create section</button>
      </form>
      <p className="section-hint" id="section-move-hint">Drag a rule handle above or below another row in the same visible section, or use its up/down buttons. Drop on a section header or empty body, or use Move to section, to change sections. Moving appends the rule after the destination’s last member, or to the end of the whole list if the section is empty. This changes evaluation order, not just labels. New rules enter Unsectioned after its last member. Continued sections preserve explicit rule moves. Names can appear as Windows comments or separate NSX policies; section metadata is temporary and not included in CSV / JSON or share links.</p>
      <div className="grouping-actions section-expansion">
        <button type="button" className="ghost" onClick={() => setExpanded(new Set(sections.map((run) => run.key)))}>Expand all</button>
        <button type="button" className="ghost" onClick={() => setExpanded(new Set())}>Collapse all</button>
      </div>
      {!rules.length && <p className="empty-state">{emptyMessage}</p>}
      {rowDrop && <p className="row-drop-hint">Drop {rowDrop.placement} rule {rules.findIndex((rule) => rule.id === rowDrop.anchorId) + 1} · {rules.find((rule) => rule.id === rowDrop.anchorId)?.name || '(unnamed)'}</p>}
      {sections.map((run) => <details className={`rule-section${dropTarget === run.key ? ' section-drop-active' : ''}`} data-section-id={run.group} data-section-start={run.key} key={run.key} open={expanded.has(run.key)}
        onDragOver={(event) => handleDragOver(event, run.key)}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setDropTarget(''); setRowDrop(null) } }}
        onDrop={(event) => handleDrop(event, run.group)}
        onToggle={(event) => {
          const open = event.currentTarget.open
          setExpanded((current) => {
            if (current.has(run.key) === open) return current
            const next = new Set(current)
            if (open) next.add(run.key); else next.delete(run.key)
            return next
          })
        }}>
        <summary><span className="section-caret" aria-hidden="true">›</span><strong>{titleOf(run.group)}{run.continued ? ' (continued)' : ''}</strong><span className="section-range">{run.entries.length ? `Rules ${run.entries[0].index + 1}–${run.entries.at(-1)!.index + 1}` : 'Empty · drop here'}</span><span className="section-count">{run.entries.length} rules · {run.entries.filter(({ rule }) => rule.enabled).length} enabled</span></summary>
        <div className="section-settings">{run.group !== 'unsectioned' ? <label>Section name<input aria-label={`Section name for ${titleOf(run.group)}${run.continued ? ' (continued)' : ''}`} value={Object.hasOwn(titles, run.group) ? titles[run.group] : ''} onChange={(event) => setTitles((current) => ({ ...current, [run.group]: event.target.value }))} /></label> : <span>New rules start in Unsectioned. This section is always available.</span>}</div>
        {run.entries.length ? <>
          {children(run.entries, renderRuleControls)}
        </> : <p className="section-empty">Drop a rule here or choose this section from a rule’s Move menu.</p>}
        <div className="rule-add-footer"><button type="button" className="ghost action-button add-action" aria-label={`Add rule to ${titleOf(run.group)}`} onClick={() => onAdd(run.group)}><ButtonIcon name="add" />Add rule</button></div>
      </details>)}
    </>}
  </div>
}
