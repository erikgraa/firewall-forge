import { useEffect, useMemo, useState } from 'react'
import { PLATFORMS, TARGETS } from './generators'
import { highlight } from './highlight'
import { csvColumns, csvExample, parseCsv, toCsv } from './csv'
import { jsonExample, parseJson, toJson } from './json'
import type { DataFormat } from './json'
import { validate } from './validate'
import { decodeState, shareUrl } from './share'
import { CUSTOM, ENDPOINTS, SERVICES, applyService, blankRule, newId, sampleRules } from './model'
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
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}
let hashHandled = false

interface Saved {
  rules: Rule[]
  target: TargetId
  policyName: string
  nsxProject?: string
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
  const [nsxProject, setNsxProject] = useState(initial.nsxProject ?? '')
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [importOpen, setImportOpen] = useState(false)
  const [csv, setCsv] = useState('')
  const [dataFormat, setDataFormat] = useState<DataFormat>('csv')
  const [importError, setImportError] = useState<string | null>(null)
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
      setNsxProject(state.nsxProject ?? '')
      setShared('Shared rules loaded.')
    })
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    localStorage.setItem(STORAGE, JSON.stringify({ rules, target, policyName, nsxProject }))
  }, [rules, target, policyName, nsxProject])

  const current = TARGETS.find((t) => t.id === target)!
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
  const rowStyle = { gridTemplateColumns: gridCols, minWidth: `${960 + extras.length * 110}px` }
  const issues = useMemo(() => validate(rules, target), [rules, target])
  const errors = issues.filter((i) => i.level === 'error')
  const code = useMemo(() => current.generate(rules, { policyName, nsxProject }), [current, rules, policyName, nsxProject])
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
    const url = await shareUrl({ rules, target, policyName, nsxProject })
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
        <img src={`${import.meta.env.BASE_URL}${theme === 'light' ? 'icon-light.svg' : 'icon.svg'}`} alt="" className="logo" />
        <div>
          <h1>Firewall Forge</h1>
          <p>One rule model → NSX, SDN, Azure Local, Windows Firewall, Linux (nftables / iptables / firewalld), Cisco and Palo Alto. Runs entirely in your browser.</p>
        </div>
        <button className="ghost theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} aria-label="Toggle light / dark mode">
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </header>

      <main>
        <section className="panel rules">
          <div className="panel-head">
            <h2>Rules <span className="count">{rules.length}</span></h2>
            <div className="actions">
              <button className="ghost" onClick={() => setImportOpen(true)}>Import</button>
              <button className="ghost" onClick={exportData} disabled={rules.length === 0}>Export</button>
              {formatSwitch}
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
            {rules.length === 0 && <div className="empty">No rules yet — add one or import a CSV / JSON file.</div>}
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
              {platforms.map((p) => (
                <button key={p.platform} className={p.platform === current.platform ? 'tab active' : 'tab'} onClick={() => pickPlatform(p.platform)}>
                  {p.label}
                  <small>{TARGETS.filter((t) => t.platform === p.platform).map((t) => t.format).join(' · ')}</small>
                </button>
              ))}
            </div>
          </div>
          {formats.length > 1 && (
            <div className="formats">
              {formats.map((t) => (
                <button key={t.id} className={t.id === target ? 'format active' : 'format'} onClick={() => setTarget(t.id)}>
                  {t.format}
                </button>
              ))}
            </div>
          )}
          <div className="toolbar">
            <label>
              Policy / ACL name
              <input value={policyName} onChange={(e) => setPolicyName(e.target.value)} />
            </label>
            {current.platform === 'nsx' && (
              <label title="Optional. Generates the project-scoped Terraform context / API path.">
                NSX project ID (optional)
                <input value={nsxProject} placeholder="default (no project)" onChange={(e) => setNsxProject(e.target.value)} />
              </label>
            )}
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
            <textarea value={csv} onChange={(e) => pasteInto(e.target.value)} placeholder={example} />
            {importError && <div className="banner">{importError}</div>}
            <div className="actions">
              <button className="ghost" onClick={() => pasteInto(example)}>Insert example</button>
              <button className="ghost" onClick={() => saveFile(example + '\n', `firewall-rules-template-${target}.${ext}`, ext === 'csv' ? 'text/csv' : 'application/json')}>Download template</button>
              <span className="spacer" />
              <button className="ghost" onClick={() => setImportOpen(false)}>Cancel</button>
              <button className="primary" onClick={doImport} disabled={!csv.trim()}>Import</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
