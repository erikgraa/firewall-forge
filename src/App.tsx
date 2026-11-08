import { useEffect, useMemo, useRef, useState } from 'react'
import { PLATFORMS, TARGETS } from './generators'
import { highlight } from './highlight'
import { csvColumns, csvExample, parseCsv, toCsv } from './csv'
import { jsonExample, parseJson, toJson } from './json'
import type { DataFormat } from './json'
import { validate } from './validate'
import { decodeState, shareUrl } from './share'
import { CUSTOM, ENDPOINTS, NSX_CATEGORIES, SERVICES, applyService, blankRule, newId, normalizeNsxCategory, sampleRules } from './model'
import { COLUMNS, EXTRA_COLUMNS } from './columns'
import type { ColKey } from './columns'
import type { Rule, TargetId } from './model'
import './App.css'

const STORAGE = 'fwgen.v2'
const THEME_KEY = 'fwgen.theme'
type Theme = 'dark' | 'light'

const initialTheme = (): Theme => {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved === 'dark' || saved === 'light') return saved
  return 'light'
}
let hashHandled = false

interface Saved {
  rules: Rule[]
  target: TargetId
  policyName: string
  nsxProject?: string
  nsxCategory?: string
}

function Icon({ name }: { name: 'rules' | 'layers' | 'history' | 'theme' | 'shield' }) {
  const paths = {
    rules: 'M8 6h12M8 12h12M8 18h12M3 6h1M3 12h1M3 18h1',
    layers: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
    history: 'M3 11a9 9 0 1 1 3 8M3 4v7h7m2-4v6l4 2',
    theme: 'M12 3a9 9 0 1 0 9 9h-9V3Z',
    shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6',
  }
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}

const load = (): Saved => {
  try {
    const raw = localStorage.getItem(STORAGE)
    if (raw) {
      const saved = JSON.parse(raw) as Saved
      return { ...saved, rules: saved.rules.map((r) => ({ ...blankRule(), ...r })) }
    }
  } catch {
    /* ignore corrupt state */
  }
  return { rules: sampleRules(), target: 'nsx', policyName: 'generated' }
}

export default function App() {
  const initial = useMemo(() => load(), [])
  const [rules, setRules] = useState<Rule[]>(initial.rules)
  const [target, setTarget] = useState<TargetId>(initial.target)
  const [policyName, setPolicyName] = useState(initial.policyName)
  const [nsxProject, setNsxProject] = useState(initial.nsxProject ?? '')
  const [nsxCategory, setNsxCategory] = useState(normalizeNsxCategory(initial.nsxCategory))
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [importOpen, setImportOpen] = useState(false)
  const [csv, setCsv] = useState('')
  const [dataFormat, setDataFormat] = useState<DataFormat>('csv')
  const [importError, setImportError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [shared, setShared] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [outputView, setOutputView] = useState<'code' | 'validation'>('code')
  const importDialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    if (importOpen) importDialog.current?.showModal()
    else importDialog.current?.close()
  }, [importOpen])

  useEffect(() => {
    if (hashHandled || !location.hash.startsWith('#s=')) return
    hashHandled = true
    const fragment = location.hash
    const hadSaved = localStorage.getItem(STORAGE) !== null
    history.replaceState(null, '', location.pathname + location.search)
    void decodeState(fragment).then((state) => {
      if (!state) return setShared('That share link could not be read.')
      if (hadSaved && !window.confirm('Open the shared rules? This replaces the rules currently saved in this browser.')) return
      setRules(state.rules)
      setTarget(TARGETS.some((t) => t.id === state.target) ? state.target : 'nsx')
      setPolicyName(state.policyName)
      setNsxProject(state.nsxProject ?? '')
      setNsxCategory(normalizeNsxCategory(state.nsxCategory))
      setShared('Shared rules loaded.')
    })
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    localStorage.setItem(STORAGE, JSON.stringify({ rules, target, policyName, nsxProject, nsxCategory }))
  }, [rules, target, policyName, nsxProject, nsxCategory])

  const current = TARGETS.find((t) => t.id === target)!
  const platforms = PLATFORMS
  const formats = TARGETS.filter((t) => t.platform === current.platform)
  const pickPlatform = (platform: string) => {
    const options = TARGETS.filter((t) => t.platform === platform)
    const sameFormat = options.find((t) => t.format === current.format)
    setTarget((sameFormat ?? options[0]).id)
  }
  const extras = EXTRA_COLUMNS[target]
  const example = dataFormat === 'csv' ? csvExample(extras) : jsonExample({ target, policyName })
  const ext = dataFormat
  const issues = useMemo(() => validate(rules, target), [rules, target])
  const errors = issues.filter((i) => i.level === 'error')
  const code = useMemo(() => current.generate(rules, { policyName, nsxProject, nsxCategory }), [current, rules, policyName, nsxProject, nsxCategory])
  const html = useMemo(() => highlight(code), [code])
  const selected = rules.find((r) => r.id === selectedId) ?? rules[0]
  const selectedIndex = selected ? rules.findIndex((r) => r.id === selected.id) : -1
  const visibleRules = rules.filter((r) =>
    [r.name, r.source, r.destination, r.service, r.protocol, r.ports, r.action, r.direction, ...extras.map((k) => String(r[k]))]
      .some((value) => value.toLowerCase().includes(query.trim().toLowerCase())),
  )
  const enabledCount = rules.filter((r) => r.enabled).length
  const addRule = () => {
    const rule = { ...blankRule(), name: `rule-${rules.length + 1}` }
    setRules((rs) => [...rs, rule])
    setSelectedId(rule.id)
    setQuery('')
  }

  const patch = (id: string, change: Partial<Rule>) =>
    setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...change } : r)))
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
    setRules((rs) => {
      const i = rs.findIndex((x) => x.id === r.id)
      const next = [...rs]
      next.splice(i + 1, 0, copy)
      return next
    })
    setSelectedId(copy.id)
    setQuery('')
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      setShared('Could not copy output. Use Download instead.')
    }
  }
  const share = async () => {
    try {
      const url = await shareUrl({ rules, target, policyName, nsxProject, nsxCategory })
      await navigator.clipboard.writeText(url)
      setShared(url.length > 2000 ? `Link copied (${url.length} chars — very long, some apps may truncate it).` : 'Share link copied ✓')
      setTimeout(() => setShared(null), 3500)
    } catch {
      setShared('Could not copy a share link. Export your rules to keep a portable copy.')
    }
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/plain' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: current.filename })
    a.click()
    URL.revokeObjectURL(url)
  }
  const clearAll = () => {
    if (window.confirm(`Remove all ${rules.length} rule${rules.length === 1 ? '' : 's'}? Export or share first if you want to keep them.`)) setRules([])
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
      : saveFile(toJson(rules, { target, policyName }), `firewall-rules-${target}.json`, 'application/json')
  const doImport = () => {
    const result = dataFormat === 'csv' ? { rules: parseCsv(csv, extras), error: undefined as string | undefined } : parseJson(csv)
    if (!result.rules.length) return setImportError(result.error ?? 'No rules found.')
    setRules((rs) => [...rs, ...result.rules])
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
    const label = `${COLUMNS[key].title ?? COLUMNS[key].label} for ${r.name || 'unnamed rule'}`
    switch (key) {
      case 'logging':
        return (
          <label className="switch" title={COLUMNS.logging.title}>
            <input aria-label={label} type="checkbox" checked={r.logging} onChange={(e) => patch(r.id, { logging: e.target.checked })} />
            <i />
          </label>
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
      <a className="skip-link" href="#workspace">Skip to policy builder</a>
      <aside className="rail" aria-label="Application">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="Firewall Forge" className="logo" />
        <nav aria-label="Workspace navigation">
          <a href="#workspace" className="rail-item active" aria-label="Policy builder" aria-current="page"><Icon name="rules" /><span>Builder</span></a>
          <button className="rail-item" disabled title="Templates (upcoming)" aria-label="Templates (upcoming)"><Icon name="layers" /><span>Templates</span></button>
          <button className="rail-item" disabled title="History (upcoming)" aria-label="History (upcoming)"><Icon name="history" /><span>History</span></button>
        </nav>
        <button className="rail-item theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} aria-label="Toggle light / dark mode">
          <Icon name="theme" /><span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
        </button>
      </aside>
      <div className="workspace-shell">
        <header className="top">
          <div><p className="eyebrow">Firewall Forge / Workspace</p><h1>Policy builder</h1></div>
          <div className="top-actions"><span className="local-badge"><Icon name="shield" /> Browser-only workspace</span><button onClick={share}>Share link</button></div>
        </header>
        <section className="context-strip" aria-label="Policy context">
          <label>Target platform<select value={current.platform} onChange={(e) => pickPlatform(e.target.value)}>{platforms.map((p) => <option key={p.platform} value={p.platform}>{p.label}</option>)}</select></label>
          <label>Output format<select value={target} onChange={(e) => setTarget(e.target.value as TargetId)}>{formats.map((t) => <option key={t.id} value={t.id}>{t.format}</option>)}</select></label>
          <label>Policy / ACL name<input value={policyName} onChange={(e) => setPolicyName(e.target.value)} /></label>
          {current.platform === 'nsx' && <>
            <label title="NSX distributed firewall category the policy is created in.">NSX category<select value={nsxCategory} onChange={(e) => setNsxCategory(e.target.value)}>{NSX_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
            <label title="Generates the project-scoped Terraform context / API path.">NSX project ID (optional)<input value={nsxProject} placeholder="default (no project)" onChange={(e) => setNsxProject(e.target.value)} /></label>
          </>}
        </section>
        <main id="workspace" tabIndex={-1}>
          <section className="summary-grid" aria-label="Policy summary">
            <div className="summary-card"><span>Total rules</span><strong>{rules.length}</strong><small>Ordered policy entries</small></div>
            <div className="summary-card"><span>Enabled</span><strong>{enabledCount}<small> / {rules.length}</small></strong><small>Included in generated output</small></div>
            <div className="summary-card"><span>Blocking rules</span><strong>{rules.filter((r) => r.enabled && r.action !== 'ALLOW').length}</strong><small>Enabled DROP or REJECT</small></div>
            <button className={`summary-card validation-card ${errors.length ? 'has-errors' : ''}`} onClick={() => setOutputView('validation')}><span>Validation</span><strong>{issues.length}</strong><small>{errors.length} errors · {issues.length - errors.length} warnings</small></button>
          </section>
          {shared && <div className="notice" role="status">{shared}</div>}
          <div className="split-view">
            <section className="panel rules" aria-labelledby="rules-heading">
              <div className="panel-head"><div><h2 id="rules-heading">Policy rules <span className="count">{rules.length}</span></h2><p>Evaluation order is preserved. Select a rule to edit.</p></div><button className="primary" onClick={addRule}>+ Add rule</button></div>
              <div className="rules-toolbar">
                <label className="search"><span className="sr-only">Search rules</span><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search names, addresses, services…" /></label>
                <div className="actions"><button onClick={() => setImportOpen(true)}>Import</button><button onClick={exportData} disabled={!rules.length}>Export</button>{formatSwitch}<button className="danger" onClick={clearAll} disabled={!rules.length}>Clear all</button></div>
              </div>
              <datalist id="endpoints">{Object.keys(ENDPOINTS).map((e) => <option key={e} value={e} />)}</datalist>
              <div className="table" role="region" aria-label="Policy rules table" tabIndex={0}>
                <table>
                  <thead><tr><th scope="col">On</th><th scope="col">Rule / source</th><th scope="col">Destination / service</th><th scope="col">Action</th></tr></thead>
                  <tbody>{visibleRules.map((r) => <tr key={r.id} className={`${r.id === selected?.id ? 'selected' : ''} ${r.enabled ? '' : 'off'}`}>
                    <td><label className="switch"><input aria-label={`Enable ${r.name || 'unnamed rule'}`} type="checkbox" checked={r.enabled} onChange={(e) => patch(r.id, { enabled: e.target.checked })} /><i /></label></td>
                    <td><button className="rule-select" aria-pressed={r.id === selected?.id} onClick={() => setSelectedId(r.id)}><span className="rule-order">{rules.indexOf(r) + 1}</span>{r.name || 'Unnamed rule'}</button><span className="table-detail">{r.source}</span></td>
                    <td><span className="table-destination">{r.destination}</span><span className="table-detail">{r.service === CUSTOM ? `${r.protocol} · ${r.ports || 'any port'}` : r.service} · {r.direction}</span></td>
                    <td><span className={`pill ${r.action.toLowerCase()}`}>{r.action}</span></td>
                  </tr>)}</tbody>
                </table>
                {!rules.length && <div className="empty"><Icon name="rules" /><h3>Start your policy</h3><p>Add a rule, import CSV / JSON, or use the sample policy.</p><button onClick={() => { setRules(sampleRules()); setQuery('') }}>Load example rules</button></div>}
                {!!rules.length && !visibleRules.length && <div className="empty"><p>No rules match your search. Your policy is unchanged.</p><button onClick={() => setQuery('')}>Clear search</button></div>}
              </div>
              <div className="table-footer"><span>{visibleRules.length} of {rules.length} rules</span><span>Saved locally in this browser</span></div>
              {selected && <section className="inspector" aria-labelledby="inspector-heading">
                <div className="panel-head"><div><p className="eyebrow">Rule {selectedIndex + 1} / {rules.length}</p><h3 id="inspector-heading">Rule details</h3></div><div className="actions">
                  <button aria-label="Move selected rule up" title="Move up" disabled={selectedIndex === 0} onClick={() => move(selectedIndex, -1)}>↑</button>
                  <button aria-label="Move selected rule down" title="Move down" disabled={selectedIndex === rules.length - 1} onClick={() => move(selectedIndex, 1)}>↓</button>
                  <button onClick={() => duplicate(selected)}>Duplicate</button>
                  <button className="danger" onClick={() => setRules((rs) => rs.filter((r) => r.id !== selected.id))}>Delete</button>
                </div></div>
                {query && !visibleRules.some((r) => r.id === selected.id) && <p className="inspector-hint">The selected rule is outside the current search results.</p>}
                <div className="field-grid">
                  <label>Rule name<input value={selected.name} placeholder="name" onChange={(e) => patch(selected.id, { name: e.target.value })} /></label>
                  <label>Action<select className={`pill ${selected.action.toLowerCase()}`} value={selected.action} onChange={(e) => patch(selected.id, { action: e.target.value as Rule['action'] })}><option>ALLOW</option><option>DROP</option><option>REJECT</option></select></label>
                  <label>Source<input list="endpoints" value={selected.source} placeholder="CIDR / group" onChange={(e) => patch(selected.id, { source: e.target.value })} /></label>
                  <label>Destination<input list="endpoints" value={selected.destination} placeholder="CIDR / group" onChange={(e) => patch(selected.id, { destination: e.target.value })} /></label>
                  <label>Service<select value={selected.service} onChange={(e) => setRules((rs) => rs.map((r) => r.id === selected.id ? applyService(r, e.target.value) : r))}><option>{CUSTOM}</option>{Object.keys(SERVICES).map((s) => <option key={s}>{s}</option>)}</select></label>
                  <label>Direction<select value={selected.direction} onChange={(e) => patch(selected.id, { direction: e.target.value as Rule['direction'] })}><option>Inbound</option><option>Outbound</option></select></label>
                  <label>Protocol<select value={selected.protocol} disabled={selected.service !== CUSTOM} onChange={(e) => patch(selected.id, { protocol: e.target.value as Rule['protocol'] })}><option>TCP</option><option>UDP</option><option>ICMP</option><option>ANY</option></select></label>
                  <label>Ports<input value={selected.ports} disabled={selected.service !== CUSTOM} placeholder="any" onChange={(e) => patch(selected.id, { ports: e.target.value })} /></label>
                </div>
                {!!extras.length && <><h4>{current.label} options</h4><div className="field-grid">{extras.map((k) => <div className="extra-field" key={k}><span title={COLUMNS[k].title}>{COLUMNS[k].label}</span>{renderExtra(selected, k)}</div>)}</div></>}
              </section>}
            </section>
            <section className="panel output" aria-labelledby="output-heading">
              <div className="panel-head"><div><p className="eyebrow">Live preview</p><h2 id="output-heading">Generated output</h2></div><span className="format-badge">{current.format}</span></div>
              <div className="output-switch" role="group" aria-label="Output view"><button aria-pressed={outputView === 'code'} className={outputView === 'code' ? 'active' : ''} onClick={() => setOutputView('code')}>Code</button><button aria-pressed={outputView === 'validation'} className={outputView === 'validation' ? 'active' : ''} onClick={() => setOutputView('validation')}>Validation <span className="count">{issues.length}</span></button></div>
              {errors.length > 0 && <div className="banner" role="status">Fix {errors.length} error{errors.length > 1 ? 's' : ''} before using this output.</div>}
              {outputView === 'code' ? <><div className="code-toolbar"><span>{current.filename}</span><div className="actions"><button onClick={download}>Download</button><button className="primary" onClick={copy}>{copied ? 'Copied ✓' : 'Copy code'}</button></div></div><pre className="code" tabIndex={0} aria-label="Generated configuration" dangerouslySetInnerHTML={{ __html: html }} /></> : <div className="validation-results">
                <h3>Policy validation</h3><p>{errors.length} errors · {issues.length - errors.length} warnings. Checks cover the entire policy, including rules hidden by search.</p>
                {issues.length ? <ul className="issues">{issues.map((iss, i) => <li key={i} className={iss.level}><strong>{iss.level === 'error' ? 'Error' : 'Warning'}</strong><br />{iss.message}</li>)}</ul> : <div className="notice">No issues found by the local validator. Review generated output before applying.</div>}
              </div>}
              <p className="output-note"><Icon name="shield" /> Generated locally. Review and test before deployment.</p>
            </section>
          </div>
        </main>

      <footer>
        <p className="disclaimer">
          <strong>Community-driven, unofficial tool.</strong> Firewall Forge is an independent open-source project and is <strong>not affiliated with, endorsed by, or supported by any vendor</strong>.
          VMware, NSX, Broadcom, Microsoft, Azure, Windows, Cisco, Palo Alto Networks, Red Hat and all other product names and trademarks belong to their respective owners and are used for identification only.
        </p>
        <p>Generated code is a starting point, provided as is without warranty — review it against your provider / API versions and test before applying to production.</p>
        <p>
          <a href="https://github.com/erikgraa/firewall-forge" target="_blank" rel="noreferrer">Source on GitHub</a>
        </p>
      </footer>
      </div>

        <dialog ref={importDialog} className="modal" aria-labelledby="import-heading" onCancel={() => setImportOpen(false)} onClick={(e) => { if (e.target === e.currentTarget) setImportOpen(false) }}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-head">
              <h3 id="import-heading">Import rules — {current.label} ({current.format})</h3>
              {formatSwitch}
            </div>
            {dataFormat === 'csv' ? (
              <>
                <p>
                  The columns follow the selected target: <code>{csvColumns(extras).join(', ')}</code>. Switch platform or format to get that target's columns. Paste straight from a spreadsheet (tab-separated works too).
                  If the first row is a header, columns are matched by name in any order and unknown columns are ignored; without a header they are read in the order above.
                </p>
                <p>
                  <b>service</b> is a well-known service (e.g. <code>HTTPS (TCP 443)</code>) or a protocol (<code>TCP</code>, <code>UDP</code>, <code>ICMP</code>, <code>ANY</code>) with <b>ports</b> filled in.
                  <b> source</b> / <b>destination</b> accept <code>Any</code>, a well-known endpoint, or comma-separated CIDRs. <b>action</b> is ALLOW, DROP or REJECT; <b>direction</b> is Inbound or Outbound; switches such as <b>logging</b> take true/false.
                </p>
              </>
            ) : (
              <p>
                JSON keeps every rule field, including the per-target options and the enabled switch, regardless of which target is selected. Paste an exported file or a bare array of rules; unknown keys are ignored and invalid values fall back to defaults.
              </p>
            )}
            <textarea aria-label={`Rules to import as ${dataFormat.toUpperCase()}`} value={csv} onChange={(e) => pasteInto(e.target.value)} placeholder={example} />
            {importError && <div className="banner" role="alert">{importError}</div>}
            <div className="actions">
              <button className="ghost" onClick={() => pasteInto(example)}>Insert example</button>
              <button className="ghost" onClick={() => saveFile(example + '\n', `firewall-rules-template-${target}.${ext}`, ext === 'csv' ? 'text/csv' : 'application/json')}>Download template</button>
              <span className="spacer" />
              <button className="ghost" onClick={() => setImportOpen(false)}>Cancel</button>
              <button className="primary" onClick={doImport} disabled={!csv.trim()}>Import</button>
            </div>
          </div>
        </dialog>
    </div>
  )
}
