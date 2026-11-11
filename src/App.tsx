import { useEffect, useMemo, useState } from 'react'
import { PLATFORMS, TARGETS } from './generators'
import { highlight } from './highlight'
import { csvColumns, csvExample, parseCsv, toCsv } from './csv'
import { jsonExample, parseJson, toJson } from './json'
import type { DataFormat, JsonImport } from './json'
import { validate } from './validate'
import { decodeState, shareUrl } from './share'
import { CUSTOM, ENDPOINTS, NSX_CATEGORIES, ROUTEROS_CHAINS, SERVICES, applyService, blankRule, newId, normalizeNsxCategory } from './model'
import { COLUMNS, EXTRA_COLUMNS } from './columns'
import type { ColKey } from './columns'
import type { Rule, TargetId } from './model'
import './App.css'
import Topology from './TopologyView'
import GroupedRules from './GroupedRules'
import RuleTemplates from './RuleTemplates'
import ButtonIcon from './ButtonIcon'
import { appendToUnsectioned, moveRuleToSection, reorderRuleWithinSection } from './sectionMoves'
import { generateGroupedOutput } from './groupedOutput'
import { sectionRuns } from './grouping'
import { appendSectionedRules, CSV_SECTION_NOTICE, emptySections, hasSections } from './sections'
import { LEGACY_WORKSPACE_KEY, loadWorkspace, serializeWorkspace, WORKSPACE_KEY } from './workspace'
const THEME_KEY = 'fwgen.theme'
type Theme = 'dark' | 'light'

const initialTheme = (): Theme => {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved === 'dark' || saved === 'light') return saved
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}
let hashHandled = false

const BASE_COLS = '44px 44px minmax(90px, 1fr) minmax(110px, 1.2fr) minmax(110px, 1.2fr) minmax(130px, 1.1fr) minmax(90px, .9fr) 104px 108px'

const load = () => loadWorkspace(localStorage)

export default function App() {
  const initial = useMemo(load, [])
  const [rules, setRules] = useState<Rule[]>(initial.rules)
  const [target, setTarget] = useState<TargetId>(initial.target)
  const [policyName, setPolicyName] = useState(initial.policyName)
  const [nsxProject, setNsxProject] = useState(initial.nsxProject ?? '')
  const [nsxCategory, setNsxCategory] = useState(normalizeNsxCategory(initial.nsxCategory))
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [workspaceView, setWorkspaceView] = useState<'rules' | 'topology'>('rules')
  const [selectedRuleId, setSelectedRuleId] = useState(initial.rules[0]?.id ?? '')
  const activeRuleId = rules.some((rule) => rule.id === selectedRuleId) ? selectedRuleId : rules[0]?.id ?? ''
  const openTableRule = (id: string) => {
    setSelectedRuleId(id)
    setWorkspaceView('rules')
    requestAnimationFrame(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('[data-table-rule-id]')).find((element) => element.dataset.tableRuleId === id)
      const section = row?.closest('details')
      if (section) section.open = true
      row?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      row?.querySelector<HTMLInputElement>('input:not([type="checkbox"])')?.focus({ preventScroll: true })
    })
  }
  const [importOpen, setImportOpen] = useState(false)
  const [csv, setCsv] = useState('')
  const [dataFormat, setDataFormat] = useState<DataFormat>('csv')
  const [importError, setImportError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [shared, setShared] = useState<string | null>(null)
  const [templateNotice, setTemplateNotice] = useState<{ message: string; ruleIds: string[] } | null>(null)
  const [membership, setMembership] = useState(initial.sections.membership)
  const [sectionTitles, setSectionTitles] = useState(initial.sections.titles)
  const [nsxSeparatePolicies, setNsxSeparatePolicies] = useState(initial.sections.nsxSeparatePolicies)
  const [dataWarnings, setDataWarnings] = useState(initial.warnings)
  const sections = { membership, titles: sectionTitles, nsxSeparatePolicies }
  const sectioned = hasSections(rules, sections)
  const addTemplate = (added: Rule[], title: string) => {
    if (!added.length) return
    setRules((current) => appendToUnsectioned(current, added, membership))
    setSelectedRuleId(added[0].id)
    setWorkspaceView('rules')
    setTemplateNotice({
      message: `${title}: added ${added.length} disabled rule${added.length === 1 ? '' : 's'} to the end of Unsectioned, which may precede named sections. Addresses start as Any. Set source and destination, review direction, chain and scope, then enable when ready.`,
      ruleIds: added.map((rule) => rule.id),
    })
  }
  const addRule = (groupId = 'unsectioned') => {
    if (!Object.hasOwn(sectionTitles, groupId)) return
    const rule = { ...blankRule(), name: `rule-${rules.length + 1}` }
    if (groupId === 'unsectioned') {
      setRules((current) => appendToUnsectioned(current, [rule], membership))
    } else {
      const result = moveRuleToSection([...rules, rule], membership, rule.id, groupId)
      setRules(result.rules)
      setMembership(result.membership)
    }
    setSelectedRuleId(rule.id)
  }
  const moveToSection = (ruleId: string, groupId: string) => {
    if (!Object.hasOwn(sectionTitles, groupId)) return
    const result = moveRuleToSection(rules, membership, ruleId, groupId)
    if (result.fromIndex < 0) return
    setRules(result.rules)
    setMembership(result.membership)
    setSelectedRuleId(ruleId)
  }
  const reorderWithinSection = (ruleId: string, anchorId: string, placement: 'before' | 'after') => {
    const result = reorderRuleWithinSection(rules, membership, ruleId, anchorId, placement)
    if (result.fromIndex < 0 || result.fromIndex === result.toIndex) return
    setRules(result.rules)
    setSelectedRuleId(ruleId)
  }

  useEffect(() => {
    if (hashHandled || !location.hash.startsWith('#s=')) return
    hashHandled = true
    const fragment = location.hash
    const hadSaved = localStorage.getItem(WORKSPACE_KEY) !== null || localStorage.getItem(LEGACY_WORKSPACE_KEY) !== null
    history.replaceState(null, '', location.pathname + location.search)
    void decodeState(fragment).then((state) => {
      if (!state) return setShared('That share link could not be read.')
      if (hadSaved && !window.confirm('Open the shared workspace? This replaces the rules, sections and policy settings currently saved in this browser.')) return
      setRules(state.rules)
      setTarget(TARGETS.some((t) => t.id === state.target) ? state.target : 'nsx')
      setPolicyName(state.policyName)
      setNsxProject(state.nsxProject ?? '')
      setNsxCategory(normalizeNsxCategory(state.nsxCategory))
      const restored = state.sections ?? emptySections()
      setMembership(restored.membership)
      setSectionTitles(restored.titles)
      setNsxSeparatePolicies(restored.nsxSeparatePolicies)
      setDataWarnings(state.warnings ?? [])
      setShared('Shared workspace loaded.')
    })
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    if (!initial.canSave) return
    try {
      localStorage.setItem(WORKSPACE_KEY, serializeWorkspace({ rules, target, policyName, nsxProject, nsxCategory, sections: { membership, titles: sectionTitles, nsxSeparatePolicies } }))
    } catch {
      const timer = window.setTimeout(() => setDataWarnings(['Workspace could not be saved in this browser. Export JSON or copy a share link before leaving.']), 0)
      return () => window.clearTimeout(timer)
    }
  }, [rules, target, policyName, nsxProject, nsxCategory, membership, sectionTitles, nsxSeparatePolicies, initial.canSave])

  const current = TARGETS.find((t) => t.id === target)!
  const routeros = current.platform === 'mikrotik'
  const platforms = PLATFORMS
  const formats = TARGETS.filter((t) => t.platform === current.platform)
  const pickPlatform = (platform: string) => {
    const options = TARGETS.filter((t) => t.platform === platform)
    const sameFormat = options.find((t) => t.format === current.format)
    setTarget((sameFormat ?? options[0]).id)
  }
  const extras = EXTRA_COLUMNS[target]
  const gridCols = `${BASE_COLS} ${extras.map((k) => COLUMNS[k].width).join(' ')} 118px`.replace(/\s+/g, ' ')
  const example = dataFormat === 'csv' ? csvExample(extras) : jsonExample({ target, policyName })
  const ext = dataFormat
  const rowStyle = { gridTemplateColumns: gridCols, minWidth: `${1004 + extras.length * 110}px` }
  const issues = useMemo(() => rules.length ? validate(target === 'azfw-ps' || target === 'azfw-cli' ? rules.filter((rule) => rule.enabled) : rules, target) : [], [rules, target])
  const errors = issues.filter((i) => i.level === 'error')
  const output = useMemo(() => generateGroupedOutput(rules, target, { policyName, nsxProject, nsxCategory }, sectionRuns(rules, membership), sectionTitles, nsxSeparatePolicies), [rules, target, policyName, nsxProject, nsxCategory, membership, sectionTitles, nsxSeparatePolicies])
  const code = output.code
  const html = useMemo(() => highlight(code), [code])

  const patch = (id: string, change: Partial<Rule>) => {
    const rule = rules.find((r) => r.id === id)
    if (templateNotice?.ruleIds.includes(id) && rule &&
      ((change.source !== undefined && change.source !== rule.source) ||
       (change.destination !== undefined && change.destination !== rule.destination))) {
      setTemplateNotice(null)
    }
    setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...change } : r)))
  }
  const move = (i: number, d: number) =>
    setRules((rs) => {
      const j = i + d
      if (j < 0 || j >= rs.length) return rs
      const next = [...rs]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  const duplicate = (r: Rule) => {
    const copy = { ...r, id: newId(), name: `${r.name}-copy` }
    setRules((current) => appendToUnsectioned(current, [copy], membership))
    setSelectedRuleId(copy.id)
  }

  const copy = async () => {
    if (output.blocked || !code.trim() || (routeros && errors.length > 0)) return
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  const share = async () => {
    const url = await shareUrl({ rules, target, policyName, nsxProject, nsxCategory, sections })
    await navigator.clipboard.writeText(url)
    setShared(url.length > 2000 ? `Link copied (${url.length} chars — very long, some apps may truncate it).` : 'Share link copied ✓')
    setTimeout(() => setShared(null), 3500)
  }
  const download = () => {
    if (output.blocked || !code.trim() || (routeros && errors.length > 0)) return
    const url = URL.createObjectURL(new Blob([code], { type: 'text/plain' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: current.filename })
    a.click()
    URL.revokeObjectURL(url)
  }
  const clearAll = () => {
    if (window.confirm(`Remove all ${rules.length} rule${rules.length === 1 ? '' : 's'}${sectioned ? ' and section metadata' : ''}? Export or share first if you want to keep them.`)) {
      setRules([])
      setTemplateNotice(null)
      setMembership({})
      setSectionTitles({ unsectioned: 'Unsectioned' })
      setNsxSeparatePolicies(false)
    }
  }
  const saveFile = (text: string, filename: string, type = 'text/plain') => {
    const url = URL.createObjectURL(new Blob([text], { type }))
    const a = Object.assign(document.createElement('a'), { href: url, download: filename })
    a.click()
    URL.revokeObjectURL(url)
  }
  const exportData = () =>
    dataFormat === 'csv'
      ? saveFile(toCsv(rules, extras), `firewall-rules-${target}.csv`, 'text/csv')
      : saveFile(toJson(rules, { target, policyName, nsxProject, nsxCategory, sections }), `firewall-rules-${target}.json`, 'application/json')
  const doImport = () => {
    const result: JsonImport = dataFormat === 'csv' ? { rules: parseCsv(csv, extras) } : parseJson(csv, target)
    if (result.error || (!result.rules.length && !result.sections)) return setImportError(result.error ?? 'No rules found.')
    let warnings = result.warnings ?? []
    if (result.sections) {
      const merged = appendSectionedRules(rules, sections, result.rules, result.sections)
      if (merged.error) return setImportError(merged.error)
      setRules(merged.rules)
      setMembership(merged.sections.membership)
      setSectionTitles(merged.sections.titles)
      setNsxSeparatePolicies(merged.sections.nsxSeparatePolicies)
      warnings = [...warnings, ...merged.warnings]
    } else {
      setRules((rs) => appendToUnsectioned(rs, result.rules, membership))
    }
    if (!rules.length && result.meta) {
      if (TARGETS.some((candidate) => candidate.id === result.meta?.target)) setTarget(result.meta.target!)
      if (result.meta.policyName !== undefined) setPolicyName(result.meta.policyName)
      setNsxProject(result.meta.nsxProject ?? '')
      setNsxCategory(normalizeNsxCategory(result.meta.nsxCategory))
    }
    setDataWarnings(warnings)
    setCsv('')
    setImportError(null)
    setImportOpen(false)
  }
  const pasteInto = (value: string) => {
    setCsv(value)
    setImportError(null)
    const first = value.trimStart()[0]
    if (dataFormat === 'csv' && (first === '{' || first === '[')) setDataFormat('json')
  }

  const formatSwitch = (
    <div className="seg" role="group" aria-label="Data format">
      {(['csv', 'json'] as const).map((f) => (
        <button key={f} className={dataFormat === f ? 'on' : ''} onClick={() => { setDataFormat(f); setImportError(null) }}>
          {f.toUpperCase()}
        </button>
      ))}
    </div>
  )
  const renderExtra = (r: Rule, key: ColKey) => {
    const label = `${COLUMNS[key].label} for ${r.name}`
    switch (key) {
      case 'logging':
        return (
          <label className="switch" title={COLUMNS.logging.title}>
            <input aria-label={label} type="checkbox" checked={r.logging} onChange={(e) => patch(r.id, { logging: e.target.checked })} />
            <i />
          </label>
        )
      case 'routerosChain':
        return (
          <select aria-label={`RouterOS chain for ${r.name}`} title={COLUMNS.routerosChain.title} value={r.routerosChain} onChange={(e) => patch(r.id, { routerosChain: e.target.value as Rule['routerosChain'] })}>
            {ROUTEROS_CHAINS.map((chain) => <option key={chain}>{chain}</option>)}
          </select>
        )
      case 'profile':
        return (
          <select aria-label={label} value={r.profile} onChange={(e) => patch(r.id, { profile: e.target.value as Rule['profile'] })}>
            <option>Any</option><option>Domain</option><option>Private</option><option>Public</option>
          </select>
        )
      case 'permanent':
        return (
          <label className="switch" title={COLUMNS.permanent.title}>
            <input aria-label={label} type="checkbox" checked={r.permanent} onChange={(e) => patch(r.id, { permanent: e.target.checked })} />
            <i />
          </label>
        )
      case 'priority':
        return <input aria-label={label} value={r.priority} placeholder="auto" onChange={(e) => patch(r.id, { priority: e.target.value })} />
      case 'program':
        return <input aria-label={label} value={r.program} placeholder="C:\path\app.exe" onChange={(e) => patch(r.id, { program: e.target.value })} />
      case 'zone':
        return <input aria-label={label} value={r.zone} placeholder="public" onChange={(e) => patch(r.id, { zone: e.target.value })} />
      case 'scope':
        return <input aria-label={label} value={r.scope} placeholder="/infra/domains/default/groups/…" onChange={(e) => patch(r.id, { scope: e.target.value })} />
      case 'srcZone':
        return <input aria-label={label} value={r.srcZone} placeholder="any" onChange={(e) => patch(r.id, { srcZone: e.target.value })} />
      case 'dstZone':
        return <input aria-label={label} value={r.dstZone} placeholder="any" onChange={(e) => patch(r.id, { dstZone: e.target.value })} />
      case 'notes':
        return <input aria-label={label} value={r.notes} placeholder="notes" onChange={(e) => patch(r.id, { notes: e.target.value })} />
    }
  }

  return (
    <div className="app">
      <header className="top">
        <a className="logo-link" href="https://firewallforge.graa.dev" aria-label="Firewall Forge home">
          <img src={`${import.meta.env.BASE_URL}${theme === 'light' ? 'icon-light.svg' : 'icon.svg'}`} alt="" className="logo" />
        </a>
        <div>
          <h1>Firewall Forge</h1>
          <p>One rule model → NSX, SDN, Azure Local, Windows Firewall, Linux (nftables / iptables / firewalld), Cisco, Palo Alto and MikroTik. Runs entirely in your browser.</p>
        </div>
        <button className="ghost theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} aria-label="Toggle light / dark mode">
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </header>

      <main>
        <section className="panel rules">
          <details open className="policy-workspace">
          <summary className="workspace-summary">Policy workspace <span className="count">{rules.length}</span></summary>
          <div className="panel-head">
            <div className="actions">
              <button className="ghost action-button import-action" onClick={() => setImportOpen(true)}><ButtonIcon name="import" />Import</button>
              <button className="ghost action-button export-action" onClick={exportData} disabled={rules.length === 0 && !(dataFormat === 'json' && sectioned)}><ButtonIcon name="export" />Export</button>
              {formatSwitch}
              <button className="ghost action-button clear-action" onClick={clearAll} disabled={rules.length === 0 && !sectioned}><ButtonIcon name="clear" />Clear all</button>
            </div>
          </div>
          {dataFormat === 'csv' && sectioned && <p className="notice">{CSV_SECTION_NOTICE}</p>}
          {dataWarnings.length > 0 && <div className="notice" role="status">{dataWarnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}

          <datalist id="endpoints">
            {Object.keys(ENDPOINTS).map((e) => <option key={e} value={e} />)}
          </datalist>

          <RuleTemplates rules={rules} target={target} onAdd={addTemplate} />
          {templateNotice && <p className="notice" role="status">{templateNotice.message}</p>}

          <div className="workspace-tabs" role="tablist" aria-label="Policy workspace view" onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return
            event.preventDefault()
            const next = event.key === 'Home' ? 'rules' : event.key === 'End' ? 'topology' : workspaceView === 'rules' ? 'topology' : 'rules'
            setWorkspaceView(next)
            requestAnimationFrame(() => document.getElementById(`${next}-view-tab`)?.focus())
          }}>
            <span className="workspace-tabs-label" aria-hidden="true">View</span>
            {(['rules', 'topology'] as const).map((view) => <button key={view} id={`${view}-view-tab`} role="tab" aria-controls={`${view}-view`} aria-selected={workspaceView === view} tabIndex={workspaceView === view ? 0 : -1} onClick={() => setWorkspaceView(view)}><span className="view-icon" aria-hidden="true">{view === 'rules' ? '▤' : '◎'}</span>{view === 'rules' ? 'Rules' : 'Topology'}</button>)}
          </div>
          <div id="topology-view" role="tabpanel" aria-labelledby="topology-view-tab" hidden={workspaceView !== 'topology'}>
            {workspaceView === 'topology' && <Topology rules={rules} target={target} platformLabel={platforms.find((platform) => platform.platform === current.platform)?.label ?? current.label} selectedId={activeRuleId} onSelect={setSelectedRuleId} onPatch={patch} onOpenTable={openTableRule} extraFields={(rule) => <div className="topology-extra">{extras.map((key) => <div key={key} className="topology-field" role="group" aria-label={COLUMNS[key].label}><span>{COLUMNS[key].label}</span>{renderExtra(rule, key)}</div>)}</div>} />}
            {workspaceView === 'topology' && <div className="rule-add-footer"><button className="ghost action-button add-action" onClick={() => addRule()}><ButtonIcon name="add" />Add rule</button></div>}
          </div>
          <div id="rules-view" role="tabpanel" aria-labelledby="rules-view-tab" hidden={workspaceView !== 'rules'}>
            <GroupedRules rules={rules} membership={membership} titles={sectionTitles} setTitles={setSectionTitles} onMove={moveToSection} onAdd={addRule} onReorder={reorderWithinSection}>{(entries, controls) => <div className="table">
            <div className="row head" style={rowStyle}>
              <span>#</span><span /><span>Name</span><span>Source</span><span>Destination</span><span>Service</span>
              <span>Ports</span><span>Action</span><span>Dir</span>
              {extras.map((k) => <span key={k} title={COLUMNS[k].title}>{COLUMNS[k].label}</span>)}
              <span />
            </div>
            {entries.map(({ rule: r, index: i }) => (
              <div key={r.id} data-table-rule-id={r.id} className={`row ${r.enabled ? '' : 'off'} ${activeRuleId === r.id ? 'topology-selected' : ''}`} style={rowStyle} onFocusCapture={() => setSelectedRuleId(r.id)} onClick={() => setSelectedRuleId(r.id)}>
                <span className="rule-order" aria-label={`Evaluation position ${i + 1}`}>{i + 1}</span>
                <label className="switch" title="Enable / disable">
                  <input type="checkbox" checked={r.enabled} onChange={(e) => patch(r.id, { enabled: e.target.checked })} />
                  <i />
                </label>
                {controls ? <div className="rule-name-cell"><input value={r.name} placeholder="name" onChange={(e) => patch(r.id, { name: e.target.value })} />{controls({ rule: r, index: i })}</div> : <input value={r.name} placeholder="name" onChange={(e) => patch(r.id, { name: e.target.value })} />}
                <input list="endpoints" value={r.source} placeholder="CIDR / group" onChange={(e) => patch(r.id, { source: e.target.value })} />
                <input list="endpoints" value={r.destination} placeholder="CIDR / group" onChange={(e) => patch(r.id, { destination: e.target.value })} />
                <select value={r.service} onChange={(e) => setRules((rs) => rs.map((x) => (x.id === r.id ? applyService(x, e.target.value) : x)))}>
                  <option>{CUSTOM}</option>
                  {Object.keys(SERVICES).map((s) => <option key={s}>{s}</option>)}
                </select>
                <div className="ports">
                  {r.service === CUSTOM && (
                    <select value={r.protocol} onChange={(e) => patch(r.id, { protocol: e.target.value as Rule['protocol'] })}>
                      <option>TCP</option><option>UDP</option><option>ICMP</option><option>ANY</option>
                    </select>
                  )}
                  <input value={r.ports} disabled={r.service !== CUSTOM} placeholder="any" onChange={(e) => patch(r.id, { ports: e.target.value })} />
                </div>
                <select aria-label={`Action for ${r.name}`} className={`pill ${r.action.toLowerCase()}`} value={r.action} onChange={(e) => patch(r.id, { action: e.target.value as Rule['action'] })}>
                  <option value="ALLOW">ALLOW</option><option value="DROP">DROP</option><option value="REJECT">REJECT</option>
                </select>
                <select aria-label={`Direction for ${r.name}`} disabled={routeros && r.routerosChain !== 'Auto'} title={routeros ? 'Auto chain uses Direction; an explicit Chain overrides it.' : undefined} value={r.direction} onChange={(e) => patch(r.id, { direction: e.target.value as Rule['direction'] })}>
                  <option>Inbound</option><option>Outbound</option>
                </select>
                {extras.map((k) => <div key={k} className="cell">{renderExtra(r, k)}</div>)}
                <div className="row-actions">
                  {!controls && <>
                    <button title="Move up" onClick={() => move(i, -1)}>↑</button>
                    <button title="Move down" onClick={() => move(i, 1)}>↓</button>
                  </>}
                  <button title="Duplicate into Unsectioned" onClick={() => duplicate(r)}>⧉</button>
                  <button title="Delete" className="danger" onClick={() => setRules((rs) => rs.filter((x) => x.id !== r.id))}>✕</button>
                </div>
              </div>
            ))}
            </div>}</GroupedRules>
          </div>

          {issues.length > 0 && (
            <ul className="issues">
              {issues.map((iss, i) => (
                <li key={i} className={iss.level}>{iss.level === 'error' ? '⛔' : '⚠️'} {iss.message}</li>
              ))}
            </ul>
          )}
          </details>
        </section>

        <section className="panel output">
            <details open>
            <summary className="output-summary">Generated output</summary>
            <fieldset className="product-picker">
              <legend>Firewall product</legend>
              <p>Choose a product, then select its output format below.</p>
              <div className="tabs" role="group" aria-label="Firewall platform">
                {platforms.map((p) => (
                  <button key={p.platform} className={p.platform === current.platform ? 'tab active' : 'tab'} data-platform={p.platform} aria-pressed={p.platform === current.platform} onClick={() => pickPlatform(p.platform)}>
                    <span>{p.platform === current.platform && <span className="selection-mark" aria-hidden="true">✓ </span>}{p.label}</span>
                    <small>{TARGETS.filter((t) => t.platform === p.platform).map((t) => t.format).join(' · ')}</small>
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="formats" role="group" aria-label="Output format">
              <span className="formats-label">Output format</span>
              {formats.map((t) => (
                <button key={t.id} className={t.id === target ? 'format active' : 'format'} aria-pressed={t.id === target} data-format={t.format} onClick={() => setTarget(t.id)}>
                  {t.id === target && <span className="selection-mark" aria-hidden="true">✓ </span>}{t.format}
                </button>
              ))}
            </div>
            {current.platform === 'nsx' && <label className="notice nsx-layout">NSX policy layout
              <select aria-label="NSX policy layout" value={nsxSeparatePolicies ? 'separate' : 'single'} onChange={(event) => setNsxSeparatePolicies(event.target.value === 'separate')}>
                <option value="single">One security policy (default)</option>
                <option value="separate">One security policy per section — preview</option>
              </select>
            </label>}
            <div className="toolbar">
              <label>
                Policy / ACL name
                <input value={policyName} onChange={(e) => setPolicyName(e.target.value)} />
              </label>
              {current.platform === 'nsx' && (
                <>
                  <label title="NSX distributed firewall category the policy is created in.">
                    NSX category
                    <select value={nsxCategory} onChange={(e) => setNsxCategory(e.target.value)}>
                      {NSX_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </label>
                  <label title="Optional. Generates the project-scoped Terraform context / API path.">
                    NSX project ID (optional)
                    <input value={nsxProject} placeholder="default (no project)" onChange={(e) => setNsxProject(e.target.value)} />
                  </label>
                </>
              )}
              <div className="actions">
                <button className="ghost" onClick={share}><ButtonIcon name="share" />Share link</button>
                <button className="ghost" onClick={download} disabled={!code.trim() || output.blocked || (routeros && errors.length > 0)}><ButtonIcon name="download" />Download {current.filename}</button>
                <button className="primary" onClick={copy} disabled={!code.trim() || output.blocked || (routeros && errors.length > 0)}><ButtonIcon name="copy" />{copied ? 'Copied ✓' : 'Copy'}</button>
              </div>
            </div>
            {routeros && <div className="notice">RouterOS 7.x · IPv4 filter · {target === 'mikrotik-tf' ? 'Terraform-managed rules and ordering. Apply can update/delete managed rules; changes are not atomic. Review placement relative to existing rules and management access. Configure HTTPS and credentials outside the browser.' : 'append-only .rsc. Review existing rules and management access before importing; reimport duplicates rules.'} Chain: input = to router, output = from router, forward = through router. Auto uses Direction. Policy name is descriptive only.{errors.length > 0 && ' Generation blocked: fix rule errors, including disabled rules, first.'}</div>}
            {shared && <div className="notice">{shared}</div>}
            {errors.length > 0 && <div className="banner">Fix {errors.length} error{errors.length > 1 ? 's' : ''} before using this output.</div>}
            {output.warnings.length > 0 && <div className="notice">{output.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
            <pre className="code" dangerouslySetInnerHTML={{ __html: rules.length ? html : 'Your workspace is empty. Add a rule or choose a starter template to generate output.' }} />
          </details>
        </section>
      </main>

      <footer>
        <p className="disclaimer">
          <strong>Community-driven, unofficial tool.</strong> Firewall Forge is an independent open-source project and is <strong>not affiliated with, endorsed by, or supported by any vendor</strong>.
          VMware, NSX, Broadcom, Microsoft, Azure, Windows, Cisco, Palo Alto Networks, Red Hat and all other product names and trademarks belong to their respective owners and are used for identification only.
        </p>
        <p>Generated code is a starting point, provided as is without warranty — review it against your provider / API versions and test before applying to production.</p>
        <p>
          Firewall Forge v{__APP_VERSION__} · <a href="https://github.com/erikgraa/firewall-forge" target="_blank" rel="noreferrer">Source on GitHub</a>
        </p>
      </footer>

      {importOpen && (
        <div className="modal" onClick={() => setImportOpen(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-head">
              <h3>Import rules — {current.label} ({current.format})</h3>
              {formatSwitch}
            </div>
            {dataFormat === 'csv' ? (
              <>
                <p>
                  The columns follow the selected target: <code>{csvColumns(extras).join(', ')}</code>. Switch platform or format to get that target's columns. Paste straight from a spreadsheet (tab-separated works too).
                  If the first row is a header, columns are matched by name in any order and unknown columns are ignored; without a header they are read in the order above.
                </p>
                <p className="notice">{CSV_SECTION_NOTICE}</p>
                <p>
                  <b>service</b> is a well-known service (e.g. <code>HTTPS (TCP 443)</code>) or a protocol (<code>TCP</code>, <code>UDP</code>, <code>ICMP</code>, <code>ANY</code>) with <b>ports</b> filled in.
                  <b> source</b> / <b>destination</b> accept <code>Any</code>, a well-known endpoint, or comma-separated CIDRs. <b>action</b> is ALLOW, DROP or REJECT; <b>direction</b> is Inbound or Outbound; switches such as <b>logging</b> take true/false.
                </p>
              </>
            ) : (
              <p>
                JSON keeps every rule field, section names/membership and NSX policy layout. Exported workspaces restore target and policy settings when imported into an empty workspace. Section-bearing JSON appends an intact ordered block to existing rules; overlapping section IDs are rejected. Older exports and bare arrays enter Unsectioned. Invalid section metadata is ignored with a warning; rule order is not sorted.
              </p>
            )}
            <textarea value={csv} onChange={(e) => pasteInto(e.target.value)} placeholder={example} />
            {importError && <div className="banner">{importError}</div>}
            <div className="actions">
              <button className="ghost" onClick={() => pasteInto(example)}>Insert example</button>
              <button className="ghost" onClick={() => saveFile(example + '\n', `firewall-rules-template-${target}.${ext}`, ext === 'csv' ? 'text/csv' : 'application/json')}>Download template</button>
              <span className="spacer" />
              <button className="ghost" onClick={() => setImportOpen(false)}>Cancel</button>
              <button className="action-button import-action" onClick={doImport} disabled={!csv.trim()}><ButtonIcon name="import" />Import</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
