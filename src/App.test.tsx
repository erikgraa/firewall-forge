import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import App from './App'
import { TARGETS } from './generators'
import { supportsDisabledRules } from './disabledRules'
import { blankRule } from './model'
import { serializeWorkspace, WORKSPACE_KEY } from './workspace'
import { emptySections } from './sections'

afterEach(() => vi.unstubAllGlobals())

describe('persisted section workspace', () => {
  it.each(['windows', 'nsx', 'fmc'] as const)('%s restores named sections on reload and shows relevant CSV metadata-loss disclosure', (target) => {
    const rules = [{ ...blankRule(), id: 'saved-a', name: 'first' }, { ...blankRule(), id: 'saved-b', name: 'second', enabled: false }]
    const sections = { ...emptySections(), titles: { unsectioned: 'Unsectioned', a: 'Saved application', b: 'Saved disabled' }, membership: { 'saved-a': 'a', 'saved-b': 'b' }, nsxSeparatePolicies: true }
    const stored = serializeWorkspace({ rules, target, policyName: 'restored', sections })
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'fwgen.theme' ? 'light' : key === WORKSPACE_KEY ? stored : null })
    const markup = renderToStaticMarkup(<App />)
    expect(markup).toContain('CSV is rule-only: section names, membership and NSX policy layout are not included.')
    expect(markup).not.toContain('Section metadata is temporary')
    expect(markup).toContain('value="restored"')
    if (target === 'windows') {
      expect(markup).toContain('Group: Saved application')
      expect(markup).toContain('Group: Saved disabled')
      expect(markup).toContain('Windows sections are editor organization')
    }
    if (target === 'nsx') expect(markup).toContain('value="separate" selected=""')
  })

  it('shows no section persistence or CSV loss warning for an ordinary unsectioned Windows workspace', () => {
    const stored = serializeWorkspace({ rules: [{ ...blankRule(), name: 'plain' }], target: 'windows', policyName: 'plain' })
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'fwgen.theme' ? 'light' : key === WORKSPACE_KEY ? stored : null })
    const markup = renderToStaticMarkup(<App />)
    expect(markup).not.toContain('CSV is rule-only:')
    expect(markup).not.toContain('Windows sections are editor organization')
    expect(markup).not.toContain('Section metadata is temporary')
  })

  it('surfaces malformed section metadata while retaining saved rule order', () => {
    const rules = [{ ...blankRule(), name: 'first-malformed' }, { ...blankRule(), name: 'last-malformed' }]
    const stored = JSON.stringify({ version: 3, rules, target: 'windows', policyName: 'test', sections: null })
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'fwgen.theme' ? 'light' : key === WORKSPACE_KEY ? stored : null })
    const markup = renderToStaticMarkup(<App />)
    expect(markup).toContain('Invalid or unsupported section metadata was ignored')
    expect(markup.indexOf('value="first-malformed"')).toBeLessThan(markup.indexOf('value="last-malformed"'))
  })
})

describe('Azure Firewall script formats', () => {
  it.each(['azfw-ps', 'azfw-cli'] as const)('%s restores, renders both format choices and exposes replacement scope', (target) => {
    const stored = serializeWorkspace({ rules: [{ ...blankRule(), name: 'azure-web', destination: '10.20.0.10' }], target, policyName: 'azure-preview' })
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'fwgen.theme' ? 'light' : key === WORKSPACE_KEY ? stored : null })
    const markup = renderToStaticMarkup(<App />)
    expect(markup).toContain('data-platform="azfw" aria-pressed="true"')
    expect(markup).toContain('PowerShell (Az.Network)')
    expect(markup).toContain('Azure CLI (REST)')
    expect(markup).toContain('removing all previous collections/rules in that group')
    expect(markup).toContain(target === 'azfw-ps' ? 'New-AzFirewallPolicyRuleCollectionGroup' : 'az rest')
  })

  it('shows mapping errors and disables copying/downloading invalid Azure output', () => {
    const stored = serializeWorkspace({ rules: [{ ...blankRule(), name: 'azure-reject', action: 'REJECT' }], target: 'azfw-cli', policyName: 'azure-preview' })
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'fwgen.theme' ? 'light' : key === WORKSPACE_KEY ? stored : null })
    const markup = renderToStaticMarkup(<App />).replace(/<svg class="button-icon"[\s\S]*?<\/svg>/g, '')
    expect(markup).toContain('cannot represent REJECT')
    expect(markup).toContain('disabled="">Copy</button>')
    expect(markup).toContain('disabled="">Download azure-firewall.sh</button>')
    expect(markup).not.toContain('az rest --method put')
  })
})

describe('policy workspace', () => {
  it('starts expanded with accessible tabs and a clean slate for new users', () => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'fwgen.theme' ? 'light' : null })
    const markup = renderToStaticMarkup(<App />).replace(/<svg class="button-icon"[\s\S]*?<\/svg>/g, '')
    expect(markup).toContain('<details open="" class="policy-workspace"><summary class="workspace-summary">Policy workspace')
    expect(markup).toContain('id="rules-view-tab" role="tab" aria-controls="rules-view" aria-selected="true" tabindex="0"')
    expect(markup).toContain('id="topology-view" role="tabpanel" aria-labelledby="topology-view-tab" hidden=""')
    expect(markup).toContain('data-platform="nsx" aria-pressed="true"')
    expect(markup).not.toContain('Full-app concept preview')
    expect(markup).not.toContain('ssh-admin')
    expect(markup).not.toContain('data-table-rule-id=')
    expect(markup).toContain('Starter templates')
    expect(markup).toContain('Your workspace is empty.')
    expect(markup).toContain('disabled="">Copy</button>')
    expect(markup).not.toContain('load the example rules')
    expect(markup).toContain('One click adds disabled starter rules.')
    expect(markup).not.toContain('template-configuration')
    expect(markup).not.toContain('policy-fallback')
  })

  it.each(['{invalid-json', JSON.stringify({ rules: [], target: 'windows', policyName: 'saved-empty' })])('keeps invalid storage and intentionally saved empty workspaces clear (%s)', (stored) => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'fwgen.theme' ? 'light' : key === 'fwgen.v2' ? stored : null })
    const markup = renderToStaticMarkup(<App />).replace(/<svg class="button-icon"[\s\S]*?<\/svg>/g, '')
    expect(markup).not.toContain('data-table-rule-id=')
    expect(markup).toContain('Your workspace is empty.')
    expect(markup).toContain('disabled="">Copy</button>')
    expect(markup).not.toContain('ssh-admin')
  })

  it('loads existing saved rules without replacing them with preview examples', () => {
    const saved = { ...blankRule(), name: 'saved-policy', source: '10.90.0.0/24' }
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'fwgen.theme' ? 'light' : key === 'fwgen.v2' ? JSON.stringify({ rules: [saved], target: 'mikrotik', policyName: 'existing' }) : null })
    const markup = renderToStaticMarkup(<App />).replace(/<svg class="button-icon"[\s\S]*?<\/svg>/g, '')
    expect(markup).toContain(`data-table-rule-id="${saved.id}"`)
    expect(markup).toContain('value="saved-policy"')
    expect(markup).toContain('value="10.90.0.0/24"')
    expect(markup).not.toContain('value="web-in"')
  })
})

describe('flat-list ordering', () => {
  it('retains whole-list arrow controls without the section-specific warning', () => {
    const rules = [{ ...blankRule(), name: 'first-flat-rule' }, { ...blankRule(), name: 'second-flat-rule' }]
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'fwgen.theme' ? 'light' : key === 'fwgen.v2' ? JSON.stringify({ rules, target: 'windows', policyName: 'test' }) : null })
    const markup = renderToStaticMarkup(<App />)
    expect(markup.match(/title="Move up"/g)).toHaveLength(2)
    expect(markup.match(/title="Move down"/g)).toHaveLength(2)
    expect(markup).not.toContain('data-move-rule-id=')
    expect(markup).not.toContain('Experimental rule sections')
    expect(markup).not.toContain('class="preview-notice"')
  })
})

describe('rule creation placement', () => {
  it('places the flat-list Add rule control below the rules, not among configuration actions', () => {
    const rule = { ...blankRule(), name: 'footer-rule' }
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'fwgen.theme' ? 'light' : key === 'fwgen.v2' ? JSON.stringify({ rules: [rule], target: 'nsx', policyName: 'test' }) : null })
    const markup = renderToStaticMarkup(<App />).replace(/<svg class="button-icon"[\s\S]*?<\/svg>/g, '')
    const actions = markup.split('class="panel-head"')[1].split('</div>')[0]
    expect(actions).not.toContain('Add rule')
    const rulesView = markup.split('id="rules-view"')[1]
    expect(rulesView.indexOf('data-table-rule-id=')).toBeLessThan(rulesView.indexOf('class="rule-add-footer"'))
    expect(rulesView).toContain('class="ghost action-button add-action">Add rule</button>')
  })
})

describe('configuration action styling', () => {
  it('distinguishes import, export and destructive clearing without changing their labels', () => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'fwgen.theme' ? 'light' : key === 'fwgen.v2' ? JSON.stringify({ rules: [{ ...blankRule(), name: 'existing' }], target: 'nsx', policyName: 'test' }) : null })
    const markup = renderToStaticMarkup(<App />).replace(/<svg class="button-icon"[\s\S]*?<\/svg>/g, '')
    expect(markup).toContain('class="ghost action-button import-action">Import</button>')
    expect(markup).toContain('class="ghost action-button export-action">Export</button>')
    expect(markup).toContain('class="ghost action-button clear-action">Clear all</button>')
    const tabs = markup.split('class="workspace-tabs"')[1].split('</div>')[0]
    expect(tabs).toContain('class="workspace-tabs-label" aria-hidden="true">View</span>')
    expect(tabs).toContain('class="view-icon" aria-hidden="true"')
    expect(tabs).not.toContain('action-button')
  })

  it('keeps empty-state export and clear actions disabled while import remains available', () => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'fwgen.theme' ? 'light' : key === 'fwgen.v2' ? JSON.stringify({ rules: [], target: 'nsx', policyName: 'test' }) : null })
    const markup = renderToStaticMarkup(<App />).replace(/<svg class="button-icon"[\s\S]*?<\/svg>/g, '')
    expect(markup).toContain('class="ghost action-button export-action" disabled="">Export</button>')
    expect(markup).toContain('class="ghost action-button clear-action" disabled="">Clear all</button>')
    expect(markup).toContain('class="ghost action-button import-action">Import</button>')
  })
})

describe('generated output', () => {
  it('starts expanded and contains the platform selectors and generated code', () => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'fwgen.theme' ? 'light' : null })

    const markup = renderToStaticMarkup(<App />).replace(/<svg class="button-icon"[\s\S]*?<\/svg>/g, '')
    const output = markup.split('<section class="panel output">')[1].split('</section>')[0]
    expect(output).toContain('<details open=""><summary class="output-summary">Generated output</summary>')
    expect(output).toContain('aria-label="Firewall platform"')
    expect(output).toContain('<pre class="code">')
  })
})

describe.each(TARGETS.filter((target) => target.format === 'Ansible' && !supportsDisabledRules(target.id)))('$id omitted Ansible rules', (target) => {
  const render = (count: number, mixed = false) => {
    const rules = Array.from({ length: count }, (_, index) => ({ ...blankRule(), name: `inactive-${index}`, enabled: false }))
    if (mixed) rules.push({ ...blankRule(), name: 'active-rule', enabled: true })
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'fwgen.theme' ? 'light' : key === 'fwgen.v2' ? JSON.stringify({ rules, target: target.id, policyName: 'test' }) : null })
    return renderToStaticMarkup(<App />).replace(/<svg class="button-icon"[\s\S]*?<\/svg>/g, '')
  }

  it.each([1, 2])('keeps the deployment warning with blank output and disabled actions for %i disabled rules', (count) => {
    const markup = render(count)
    expect(markup).toContain('<pre class="code"></pre>')
    expect(markup).toContain(`${count} disabled rule${count === 1 ? '' : 's'} omitted:`)
    expect(markup).toContain('Omission does not disable an existing deployed rule')
    expect(markup).toContain(`disabled="">Download ${target.filename}</button>`)
    expect(markup).toContain('disabled="">Copy</button>')
    expect(markup).not.toContain('Your workspace is empty.')
    expect(markup.match(/data-table-rule-id=/g)).toHaveLength(count)
  })

  it('keeps mixed-input warnings and allows copying/downloading enabled configuration', () => {
    const markup = render(2, true)
    expect(markup).toContain('2 disabled rules omitted:')
    expect(markup).toContain('Omission does not disable an existing deployed rule')
    expect(markup).not.toContain('<pre class="code"></pre>')
    expect(markup).not.toContain(`disabled="">Download ${target.filename}</button>`)
    expect(markup).not.toContain('disabled="">Copy</button>')
  })
})

describe.each(['mikrotik', 'mikrotik-tf'])('MikroTik editor (%s)', (target) => {
  const render = (overrides = {}) => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key === 'fwgen.theme' ? 'light' : key === 'fwgen.v2' ? JSON.stringify({ rules: [{ ...blankRule(), name: 'test', ...overrides }], target, policyName: 'test' }) : null,
    })
    return renderToStaticMarkup(<App />).replace(/<svg class="button-icon"[\s\S]*?<\/svg>/g, '')
  }

  it('shows chain controls and explains their packet direction', () => {
    const markup = render()
    expect(markup).toContain('aria-label="RouterOS chain for test"')
    expect(markup).toContain('<option selected="">Auto</option>')
    expect(markup).toContain('<option>forward</option>')
    expect(markup).toContain('input = to router, output = from router, forward = through router')
    expect(markup).not.toContain('aria-label="Direction for test" disabled=""')
  })

  it('preserves but disables Direction for an explicit chain', () => {
    expect(render({ routerosChain: 'forward', direction: 'Outbound' })).toContain('aria-label="Direction for test" disabled=""')
    expect(render({ routerosChain: 'forward', direction: 'Outbound' })).toContain('<option selected="">Outbound</option>')
  })

  it('loads old stored rules with Auto and blocks invalid rule downloads', () => {
    expect(render({ routerosChain: undefined })).toContain('<option selected="">Auto</option>')
    const markup = render({ source: 'Internet' })
    expect(markup).toContain('Generation blocked: fix rule errors, including disabled rules, first.')
    expect(markup).toContain(`disabled="">Download mikrotik-firewall.${target === 'mikrotik-tf' ? 'tf' : 'rsc'}</button>`)
    expect(markup).toContain('disabled="">Copy</button>')
    expect(markup).toContain('BLOCKED:')
  })
})

describe('app version', () => {
  it('displays the shared build version in the footer without removing disclaimers or the source link', () => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'fwgen.theme' ? 'light' : null })
    const footer = renderToStaticMarkup(<App />).split('<footer>')[1].split('</footer>')[0]
    expect(footer).toContain(`Firewall Forge v${__APP_VERSION__} ·`)
    expect(footer).toContain('Community-driven, unofficial tool.')
    expect(footer).toContain('Generated code is a starting point')
    expect(footer).toContain('href="https://github.com/erikgraa/firewall-forge" target="_blank" rel="noreferrer">Source on GitHub</a>')
  })
})

describe('home logo', () => {
  it.each([
    ['light', 'icon-light.svg'],
    ['dark', 'icon.svg'],
  ])('links the %s theme icon to Firewall Forge home', (theme, icon) => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key === 'fwgen.theme' ? theme : null,
    })

    const markup = renderToStaticMarkup(<App />).replace(/<svg class="button-icon"[\s\S]*?<\/svg>/g, '')
    expect(markup).toContain(
      `<a class="logo-link" href="https://firewallforge.graa.dev" aria-label="Firewall Forge home"><img src="${import.meta.env.BASE_URL}${icon}" alt="" class="logo"/></a>`,
    )
  })

  describe('platform and output selectors', () => {
    it.each(TARGETS)('identifies the selected platform and $format format for $id', (target) => {
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => {
          if (key === 'fwgen.theme') return 'light'
          if (key === 'fwgen.v2') return JSON.stringify({ rules: [], target: target.id, policyName: 'test' })
          return null
        },
      })

      const markup = renderToStaticMarkup(<App />).replace(/<svg class="button-icon"[\s\S]*?<\/svg>/g, '')
      const platformGroup = markup.split('aria-label="Firewall platform">')[1].split('</div>')[0]
      const formatGroup = markup.split('aria-label="Output format">')[1].split('</div>')[0]
      const formats = TARGETS.filter((t) => t.platform === target.platform)

      expect(platformGroup.match(/class="tab active" data-platform="[^"]+" aria-pressed="true"/g)).toHaveLength(1)
      expect(platformGroup).toContain(`class="tab active" data-platform="${target.platform}" aria-pressed="true"><span><span class="selection-mark" aria-hidden="true">✓ </span>${target.label}</span>`)
      expect(formatGroup.match(/class="format active" aria-pressed="true"/g)).toHaveLength(1)
      expect(formatGroup.match(/aria-pressed=/g)).toHaveLength(formats.length)
      expect(formatGroup).toContain(`</span>${target.format}</button>`)
      for (const format of formats) expect(formatGroup).toContain(`data-format="${format.format}"`)
    })
  })
})


describe('product picker and decorative icons', () => {
  it('boxes the product choices separately from output formats', () => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key.endsWith('.theme') ? 'light' : null })
    const markup = renderToStaticMarkup(<App />)
    expect(markup).toContain('<fieldset class="product-picker"><legend>Firewall product</legend>')
    expect(markup).toContain('Choose a product, then select its output format below.')
    expect(markup).toContain('aria-label="Firewall platform"')
  })

  it('keeps button icons decorative and preserves their visible labels', () => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key.endsWith('.theme') ? 'light' : null })
    const markup = renderToStaticMarkup(<App />)
    const buttons = markup.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? []
    for (const label of ['Import', 'Export', 'Clear all', 'Add rule', 'Share link', 'Copy']) {
      const button = buttons.find((entry) => entry.includes(`</svg>${label}`))
      expect(button, label).toBeDefined()
      expect(button).toContain('aria-hidden="true" focusable="false"')
    }
  })

  it('gives each action option an explicit value without changing the selected action', () => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'fwgen.theme' ? 'light' : key === 'fwgen.v2' ? JSON.stringify({ rules: [{ ...blankRule(), name: 'action-test', action: 'REJECT' }], target: 'windows', policyName: 'test' }) : null })
    const markup = renderToStaticMarkup(<App />)
    expect(markup).toContain('aria-label="Action for action-test" class="pill reject"')
    for (const action of ['ALLOW', 'DROP', 'REJECT']) expect(markup.match(new RegExp(`value="${action}"`, 'g'))!.length).toBeGreaterThanOrEqual(1)
  })
})


describe('ordered sections preview integration', () => {
  it('keeps loaded rules in one flat table with visible global positions', () => {
    const rules = [blankRule(), blankRule()].map((rule, index) => ({ ...rule, name: `loaded-${index + 1}` }))
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'fwgen.theme' ? 'light' : key === 'fwgen.v2' ? JSON.stringify({ rules, target: 'windows', policyName: 'test' }) : null })
    const markup = renderToStaticMarkup(<App />)
    expect(markup.match(/class="table"/g)).toHaveLength(1)
    expect(markup).toContain('aria-label="Evaluation position 1">1</span>')
    expect(markup).toContain('aria-label="Evaluation position 2">2</span>')
    expect(markup).not.toContain('draggable="true"')
    expect(markup).not.toContain('Start new section at rule')
    expect(markup).not.toContain('Experimental rule sections')
  })
})
