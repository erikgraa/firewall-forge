import { useEffect, useMemo, useState } from 'react'
import { TARGETS } from './generators'
import { highlight } from './highlight'
import { parseCsv } from './csv'
import { validate } from './validate'
import { decodeState, shareUrl } from './share'
import { CUSTOM, ENDPOINTS, SERVICES, applyService, blankRule, newId, sampleRules } from './model'
import { COLUMNS, EXTRA_COLUMNS } from './columns'
import type { ColKey } from './columns'
import type { Rule, TargetId } from './model'
import './App.css'

const STORAGE = 'fwgen.v2'
let hashHandled = false

interface Saved {
  rules: Rule[]
  target: TargetId
  policyName: string
}

const BASE_COLS = '44px minmax(90px, 1fr) minmax(110px, 1.2fr) minmax(110px, 1.2fr) minmax(130px, 1.1fr) minmax(90px, .9fr) 104px 108px'

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
  const initial = useMemo(load, [])
  const [rules, setRules] = useState<Rule[]>(initial.rules)
  const [target, setTarget] = useState<TargetId>(initial.target)
  const [policyName, setPolicyName] = useState(initial.policyName)
  const [importOpen, setImportOpen] = useState(false)
  const [csv, setCsv] = useState('')
  const [copied, setCopied] = useState(false)
  const [shared, setShared] = useState<string | null>(null)

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
      setShared('Shared rules loaded.')
    })
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE, JSON.stringify({ rules, target, policyName }))
  }, [rules, target, policyName])

  const current = TARGETS.find((t) => t.id === target)!
  const extras = EXTRA_COLUMNS[target]
  const gridCols = `${BASE_COLS} ${extras.map((k) => COLUMNS[k].width).join(' ')} 118px`.replace(/\s+/g, ' ')
  const rowStyle = { gridTemplateColumns: gridCols, minWidth: `${960 + extras.length * 110}px` }
  const issues = useMemo(() => validate(rules, target), [rules, target])
  const errors = issues.filter((i) => i.level === 'error')
  const code = useMemo(() => current.generate(rules, { policyName }), [current, rules, policyName])
  const html = useMemo(() => highlight(code), [code])

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
  const duplicate = (r: Rule) =>
    setRules((rs) => {
      const i = rs.findIndex((x) => x.id === r.id)
      const next = [...rs]
      next.splice(i + 1, 0, { ...r, id: newId(), name: `${r.name}-copy` })
      return next
    })

  const copy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  const share = async () => {
    const url = await shareUrl({ rules, target, policyName })
    await navigator.clipboard.writeText(url)
    setShared(url.length > 2000 ? `Link copied (${url.length} chars — very long, some apps may truncate it).` : 'Share link copied ✓')
    setTimeout(() => setShared(null), 3500)
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/plain' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: current.filename })
    a.click()
    URL.revokeObjectURL(url)
  }
  const doImport = () => {
    const parsed = parseCsv(csv)
    if (parsed.length) setRules((rs) => [...rs, ...parsed])
    setCsv('')
    setImportOpen(false)
  }

  const renderExtra = (r: Rule, key: ColKey) => {
    switch (key) {
      case 'logging':
        return (
          <label className="switch" title={COLUMNS.logging.title}>
            <input type="checkbox" checked={r.logging} onChange={(e) => patch(r.id, { logging: e.target.checked })} />
            <i />
          </label>
        )
      case 'profile':
        return (
          <select value={r.profile} onChange={(e) => patch(r.id, { profile: e.target.value as Rule['profile'] })}>
            <option>Any</option><option>Domain</option><option>Private</option><option>Public</option>
          </select>
        )
      case 'permanent':
        return (
          <label className="switch" title={COLUMNS.permanent.title}>
            <input type="checkbox" checked={r.permanent} onChange={(e) => patch(r.id, { permanent: e.target.checked })} />
            <i />
          </label>
        )
      case 'priority':
        return <input value={r.priority} placeholder="auto" onChange={(e) => patch(r.id, { priority: e.target.value })} />
      case 'program':
        return <input value={r.program} placeholder="C:\path\app.exe" onChange={(e) => patch(r.id, { program: e.target.value })} />
      case 'zone':
        return <input value={r.zone} placeholder="public" onChange={(e) => patch(r.id, { zone: e.target.value })} />
      case 'scope':
        return <input value={r.scope} placeholder="/infra/domains/default/groups/…" onChange={(e) => patch(r.id, { scope: e.target.value })} />
      case 'srcZone':
        return <input value={r.srcZone} placeholder="any" onChange={(e) => patch(r.id, { srcZone: e.target.value })} />
      case 'dstZone':
        return <input value={r.dstZone} placeholder="any" onChange={(e) => patch(r.id, { dstZone: e.target.value })} />
      case 'notes':
        return <input value={r.notes} placeholder="notes" onChange={(e) => patch(r.id, { notes: e.target.value })} />
    }
  }

  return (
    <div className="app">
      <header className="top">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" className="logo" />
        <div>
          <h1>Firewall Forge</h1>
          <p>One rule model → NSX, Windows SDN, Azure Local, Windows Firewall, firewalld and Cisco. Runs entirely in your browser.</p>
        </div>
      </header>

      <main>
        <section className="panel rules">
          <div className="panel-head">
            <h2>Rules <span className="count">{rules.length}</span></h2>
            <div className="actions">
              <button className="ghost" onClick={() => setImportOpen(true)}>Import CSV</button>
              <button className="ghost" onClick={() => setRules(sampleRules())}>Reset</button>
              <button className="primary" onClick={() => setRules((rs) => [...rs, { ...blankRule(), name: `rule-${rs.length + 1}` }])}>
                + Add rule
              </button>
            </div>
          </div>

          <datalist id="endpoints">
            {Object.keys(ENDPOINTS).map((e) => <option key={e} value={e} />)}
          </datalist>

          <div className="table">
            <div className="row head" style={rowStyle}>
              <span /><span>Name</span><span>Source</span><span>Destination</span><span>Service</span>
              <span>Ports</span><span>Action</span><span>Dir</span>
              {extras.map((k) => <span key={k} title={COLUMNS[k].title}>{COLUMNS[k].label}</span>)}
              <span />
            </div>
            {rules.map((r, i) => (
              <div key={r.id} className={`row ${r.enabled ? '' : 'off'}`} style={rowStyle}>
                <label className="switch" title="Enable / disable">
                  <input type="checkbox" checked={r.enabled} onChange={(e) => patch(r.id, { enabled: e.target.checked })} />
                  <i />
                </label>
                <input value={r.name} placeholder="name" onChange={(e) => patch(r.id, { name: e.target.value })} />
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
                <select className={`pill ${r.action.toLowerCase()}`} value={r.action} onChange={(e) => patch(r.id, { action: e.target.value as Rule['action'] })}>
                  <option>ALLOW</option><option>DROP</option><option>REJECT</option>
                </select>
                <select value={r.direction} onChange={(e) => patch(r.id, { direction: e.target.value as Rule['direction'] })}>
                  <option>Inbound</option><option>Outbound</option>
                </select>
                {extras.map((k) => <div key={k} className="cell">{renderExtra(r, k)}</div>)}
                <div className="row-actions">
                  <button title="Move up" onClick={() => move(i, -1)}>↑</button>
                  <button title="Move down" onClick={() => move(i, 1)}>↓</button>
                  <button title="Duplicate" onClick={() => duplicate(r)}>⧉</button>
                  <button title="Delete" className="danger" onClick={() => setRules((rs) => rs.filter((x) => x.id !== r.id))}>✕</button>
                </div>
              </div>
            ))}
            {rules.length === 0 && <div className="empty">No rules yet — add one or import a CSV.</div>}
          </div>

          {issues.length > 0 && (
            <ul className="issues">
              {issues.map((iss, i) => (
                <li key={i} className={iss.level}>{iss.level === 'error' ? '⛔' : '⚠️'} {iss.message}</li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel output">
          <div className="panel-head">
            <div className="tabs">
              {TARGETS.map((t) => (
                <button key={t.id} className={t.id === target ? 'tab active' : 'tab'} onClick={() => setTarget(t.id)}>
                  {t.label}<small>{t.hint}</small>
                </button>
              ))}
            </div>
          </div>
          <div className="toolbar">
            <label>
              Policy / ACL name
              <input value={policyName} onChange={(e) => setPolicyName(e.target.value)} />
            </label>
            <div className="actions">
              <button className="ghost" onClick={share}>Share link</button>
              <button className="ghost" onClick={download}>Download {current.filename}</button>
              <button className="primary" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
            </div>
          </div>
          {shared && <div className="notice">{shared}</div>}
          {errors.length > 0 && <div className="banner">Fix {errors.length} error{errors.length > 1 ? 's' : ''} before using this output.</div>}
          <pre className="code" dangerouslySetInnerHTML={{ __html: html }} />
        </section>
      </main>

      <footer>Generated code is a starting point — review against your provider / API versions before applying.</footer>

      {importOpen && (
        <div className="modal" onClick={() => setImportOpen(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Import rules from CSV</h3>
            <p>Columns: <code>name, source, destination, service-or-protocol, ports, action, direction</code>. Paste straight from a spreadsheet (tab-separated works too).</p>
            <textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              placeholder={'app-in,10.0.0.0/24,web-grp,HTTPS (TCP 443),,ALLOW,Inbound\nblock-smb,Any,Any,TCP,445,DROP,Inbound'}
            />
            <div className="actions">
              <button className="ghost" onClick={() => setImportOpen(false)}>Cancel</button>
              <button className="primary" onClick={doImport} disabled={!csv.trim()}>Import</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
