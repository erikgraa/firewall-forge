import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { CUSTOM, ENDPOINTS, SERVICES, applyService } from './model'
import type { Rule, TargetId } from './model'
import { projectTopology, topologyContext } from './topology'
import './Topology.css'

interface Props {
  rules: Rule[]; target: TargetId; platformLabel: string; selectedId: string
  onSelect: (id: string) => void; onPatch: (id: string, change: Partial<Rule>) => void
  onOpenTable: (id: string) => void; extraFields: (rule: Rule) => ReactNode
}
const colors = { ALLOW: 'var(--topology-allow)', DROP: 'var(--topology-drop)', REJECT: 'var(--topology-reject)', disabled: 'var(--topology-disabled)' }
const short = (text: string, length = 20) => text.length > length ? `${text.slice(0, length - 1)}…` : text
const service = (rule: Rule) => rule.protocol === 'ANY' ? 'All protocols' : `${rule.protocol}${rule.ports.trim() ? ` ${rule.ports}` : ''}`
const label = (value: string) => value === 'Private networks (RFC1918)' ? 'Private networks' : value === 'Public DNS (1.1.1.1, 8.8.8.8)' ? 'Public DNS' : value === '*' || value === 'Any' ? 'Any address' : short(value)
const subtitle = (value: string) => value === 'Any' || value === '*' ? 'Wildcard · no address constraint' : ENDPOINTS[value] ? `${ENDPOINTS[value].net.length} preset address matcher(s)` : value.includes(',') ? 'Address matcher list' : 'Address / symbolic matcher'

export default function Topology({ rules, target, platformLabel, selectedId, onSelect, onPatch, onOpenTable, extraFields }: Props) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [showDisabled, setShowDisabled] = useState(false)
  const id = useId().replace(/:/g, '')
  const routeros = target === 'mikrotik' || target === 'mikrotik-tf'
  const graph = useMemo(() => projectTopology(rules, target, { search, chain: filter, showDisabled }), [rules, target, search, filter, showDisabled])
  const selected = rules.find((rule) => rule.id === selectedId) ?? rules[0]
  const select = (rule: Rule) => { onSelect(rule.id); setFilter('all'); if (!rule.enabled) setShowDisabled(true) }
  const contexts = routeros ? ['input', 'forward', 'output'] : ['policy']
  let nextY = 225
  const lanes = contexts.map((name) => {
    const height = 63 + Math.max(0, graph.routes.filter((route) => route.context === name).length - 1) * 28
    const lane = { name, y: nextY, height }
    nextY += height + 37
    return lane
  })
  const lastLane = lanes[lanes.length - 1]
  const filterBottom = lastLane.y + lastLane.height + 20
  const height = Math.max(590, filterBottom + 82, Math.max(0, Math.max(graph.sources.length, graph.destinations.length) - 1) * 140 + 240)
  const positions = (nodes: typeof graph.sources) => new Map(nodes.map((node, index) => [node.value, 160 + index * 140]))
  const sourceY = positions(graph.sources)
  const destinationY = positions(graph.destinations)
  const selectedErrors = selected ? graph.errors.get(selected.id) ?? [] : []
  const ruleOrders = new Map(rules.map((rule, index) => [rule.id, index + 1]))
  const offsets = new Map<string, number>()
  const routeY = new Map(graph.routes.map((route) => {
    const offset = offsets.get(route.context) ?? 0
    offsets.set(route.context, offset + 1)
    return [route.id, lanes.find((lane) => lane.name === route.context)!.y + offset * 28]
  }))

  return <div className="topology-workspace">
    <div className="topology-main">
      <div className="topology-toolbar">
        <div><h2>Rule-flow topology</h2><p>{platformLabel} · {rules.length} shared logical rules</p></div>
        <span className="topology-live">● Live edits</span>
        {routeros && <div className="seg" role="group" aria-label="Topology chain filter">{['all', ...contexts].map((name) => <button key={name} className={filter === name ? 'on' : ''} aria-pressed={filter === name} onClick={() => setFilter(name)}>{name === 'all' ? 'All chains' : name}</button>)}</div>}
        <label className="topology-toggle"><input type="checkbox" checked={showDisabled} onChange={(event) => setShowDisabled(event.target.checked)} /> Show disabled</label>
      </div>
      <div className="topology-scroll">
        <svg className="topology-svg" viewBox={`0 0 1050 ${height}`} role="group" aria-labelledby={`${id}-title ${id}-desc`}>
          <title id={`${id}-title`}>Rule intent for {platformLabel}</title>
          <desc id={`${id}-desc`}>Address matchers and configured rule decisions, not physical devices or measured traffic. Select a rule label to edit its shared data.</desc>
          <defs>{Object.entries(colors).map(([action, color]) => <marker key={action} id={`${id}-${action}`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill={color} /></marker>)}</defs>
          <text x="54" y="55" className="topology-label">SOURCE MATCHERS</text><text x="440" y="55" className="topology-label">FILTER CONTEXT</text><text x="786" y="55" className="topology-label">DESTINATION MATCHERS</text>
          {!graph.routes.length ? <g><text x="525" y="270" textAnchor="middle" className="topology-title">No valid routes in this view</text><text x="525" y="297" textAnchor="middle" className="topology-subtitle">Clear filters, enable a rule, or complete its matchers.</text></g> : <>
            <rect x="415" y="116" width="223" height={filterBottom - 116} rx="15" className="topology-filter" />
            <rect x="435" y="136" width="27" height="30" rx="7" className="topology-icon" /><text x="449" y="157" textAnchor="middle" className="topology-title">F</text>
            <text x="475" y="151" className="topology-title">Policy context</text><text x="475" y="168" className="topology-subtitle">{short(platformLabel, 24)}</text>
            {lanes.map((lane) => <g key={lane.name}><rect x="435" y={lane.y - 31} width="183" height={lane.height} rx="8" className="topology-lane" /><text x="451" y={lane.y - 5} className="topology-chain">{lane.name === 'policy' ? 'Rule intent' : lane.name}</text><text x="451" y={lane.y + 15} className="topology-subtitle">{({ input: 'to router', forward: 'through router', output: 'from router', policy: 'See target warnings' } as Record<string, string>)[lane.name]}</text></g>)}
            <text x="526" y={filterBottom - 18} textAnchor="middle" className="topology-subtitle">Logical stage · not a device</text>
            {graph.routes.map((route) => {
              const rule = route.rule
              const y = routeY.get(route.id)!
              const sy = sourceY.get(rule.source.trim())!
              const dy = destinationY.get(rule.destination.trim())!
              const active = rule.id === selected?.id
              const color = rule.enabled ? colors[rule.action] : colors.disabled
              const dim = !active && graph.routes.some((item) => item.id === selected?.id)
              return <g key={route.id} className={`topology-route ${active ? 'selected' : ''} ${dim ? 'dim' : ''}`} data-rule-id={route.id} role="button" tabIndex={0} aria-pressed={active} aria-label={`Select ${rule.name}: ${rule.enabled ? rule.action : 'disabled'}, ${service(rule)}, ${route.context}`} onClick={() => select(rule)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(rule) } }}>
                <title>{rule.name} · {service(rule)} · {route.context} · {rule.enabled ? rule.action : 'disabled'}</title>
                <path className="topology-edge" stroke={color} strokeDasharray={rule.enabled ? undefined : '5 5'} d={`M264,${sy} C336,${sy} 345,${y} 415,${y}`} markerEnd={rule.enabled ? `url(#${id}-${rule.action})` : undefined} />
                <path className="topology-edge destination-association" stroke={color} strokeDasharray={rule.enabled && rule.action === 'ALLOW' ? undefined : '5 5'} d={`M638,${y} C703,${y} 711,${dy} 786,${dy}`} markerEnd={rule.enabled && rule.action === 'ALLOW' ? `url(#${id}-ALLOW)` : undefined} />
                {rule.enabled && rule.action !== 'ALLOW' && <g><circle cx="634" cy={y} r="6" fill="var(--panel)" stroke={color} strokeWidth="2" /><path d={`M630,${y} H638`} stroke={color} strokeWidth="2" /></g>}
                <rect className="topology-route-pill" x="282" y={y - 16} width="123" height="24" rx="6" stroke={color} /><text x="343.5" y={y - 1} textAnchor="middle" fill={color} className="topology-route-label">{route.order} · {rule.enabled ? rule.action : 'OFF'} · {short(rule.name || 'Unnamed', 12)}</text>
              </g>
            })}
            {([{ nodes: graph.sources, ys: sourceY, x: 54 }, { nodes: graph.destinations, ys: destinationY, x: 786 }]).map(({ nodes, ys, x }) => nodes.map((node) => <g key={node.id} data-matcher={node.value}>
              <title>{node.value}</title><rect x={x} y={ys.get(node.value)! - 34} width="210" height="68" rx="10" className="topology-node" /><rect x={x + 12} y={ys.get(node.value)! - 17} width="30" height="34" rx="7" className="topology-icon" /><text x={x + 27} y={ys.get(node.value)! + 4} textAnchor="middle" className="topology-subtitle">IP</text><text x={x + 51} y={ys.get(node.value)! - 4} className="topology-title">{label(node.value)}</text><text x={x + 51} y={ys.get(node.value)! + 15} className="topology-subtitle">{subtitle(node.value)}</text>
            </g>))}
          </>}
        </svg>
      </div>
      <div className="topology-legend"><span>🟢 ALLOW intent</span><span>⛔ DROP · stops at filter</span><span>↩ REJECT · response</span><span>┄ Disabled</span></div>
      <p className="topology-summary" aria-live="polite">{graph.routes.length} shown / {rules.length} logical rules{graph.invalid > 0 && ` · ${graph.invalid} invalid route(s) excluded`}{selected && ` · Selected: ${selected.name || 'Unnamed'} → ${topologyContext(selected, target)} · ${service(selected)}`}</p>
      <p className="topology-caveat"><strong>A rule-intent map, not a discovered network.</strong> Nodes are address matchers. Dashed destination links are matcher associations, not delivery. ALLOW is not proof of reachability. Existing rules, order, target defaults and offload can change effective behavior. No implicit deny or return-traffic rules are added. See the shared validation warnings below.</p>
    </div>
    <aside className="topology-inspector">
      <label className="topology-field">Search rules<input aria-label="Search topology rules" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name or address matcher" /></label>
      <div className="topology-rule-list">{graph.matching.map((rule) => <button key={rule.id} className={selected?.id === rule.id ? 'selected' : ''} aria-pressed={selected?.id === rule.id} onClick={() => select(rule)}><strong>{ruleOrders.get(rule.id)} · {rule.name || 'Unnamed'}</strong><small>{rule.enabled ? rule.action : 'DISABLED'} · {service(rule)} · {topologyContext(rule, target)}{graph.errors.get(rule.id)!.length ? ' · INVALID' : ''}</small></button>)}{!graph.matching.length && <p>No matching rules.</p>}</div>
      {selected ? <div className="topology-fields"><div className="topology-inspector-head"><h3>Selected rule</h3><button onClick={() => onOpenTable(selected.id)}>Open in Rules</button></div>
        <label className="topology-field">Rule name<input aria-label="Topology rule name" value={selected.name} onChange={(event) => onPatch(selected.id, { name: event.target.value })} /></label>
        <label className="topology-field">Source matcher<input aria-label="Topology source matcher" list="endpoints" value={selected.source} onChange={(event) => onPatch(selected.id, { source: event.target.value })} /></label>
        <label className="topology-field">Destination matcher<input aria-label="Topology destination matcher" list="endpoints" value={selected.destination} onChange={(event) => onPatch(selected.id, { destination: event.target.value })} /></label>
        <label className="topology-field">Service<select aria-label="Topology service" value={selected.service} onChange={(event) => onPatch(selected.id, applyService(selected, event.target.value))}><option>{CUSTOM}</option>{Object.keys(SERVICES).map((name) => <option key={name}>{name}</option>)}</select></label>
        <div className="topology-field-pair"><label className="topology-field">Protocol<select aria-label="Topology protocol" value={selected.protocol} disabled={selected.service !== CUSTOM} onChange={(event) => onPatch(selected.id, { protocol: event.target.value as Rule['protocol'] })}>{['TCP', 'UDP', 'ICMP', 'ANY'].map((name) => <option key={name}>{name}</option>)}</select></label><label className="topology-field">Ports<input aria-label="Topology ports" disabled={selected.service !== CUSTOM} value={selected.ports} onChange={(event) => onPatch(selected.id, { ports: event.target.value })} /></label></div>
        <div className="topology-field-pair"><label className="topology-field">Action<select aria-label="Topology action" className={`pill ${selected.action.toLowerCase()}`} value={selected.action} onChange={(event) => onPatch(selected.id, { action: event.target.value as Rule['action'] })}>{['ALLOW', 'DROP', 'REJECT'].map((name) => <option key={name} value={name}>{name}</option>)}</select></label><label className="topology-field">Saved direction<select aria-label="Topology direction" value={selected.direction} disabled={routeros && selected.routerosChain !== 'Auto'} onChange={(event) => onPatch(selected.id, { direction: event.target.value as Rule['direction'] })}><option>Inbound</option><option>Outbound</option></select></label></div>
        {extraFields(selected)}
        <label className="topology-toggle"><input aria-label="Topology rule enabled" type="checkbox" checked={selected.enabled} onChange={(event) => onPatch(selected.id, { enabled: event.target.checked })} /> Enabled rule</label>
        {!!selectedErrors.length && <div className="banner">{selectedErrors.join(' ')} Invalid routes are excluded, never substituted with Any.</div>}
      </div> : <p>Add or import a rule to start exploring.</p>}
    </aside>
  </div>
}
