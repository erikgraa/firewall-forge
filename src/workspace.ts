import { TARGETS } from './generators'
import { blankRule, newId, normalizeNsxCategory } from './model'
import type { Rule, TargetId } from './model'
import { emptySections, restoreSections, serializeSections } from './sections'
import type { SectionState } from './sections'

export const WORKSPACE_KEY = 'fwgen.v3'
export const LEGACY_WORKSPACE_KEY = 'fwgen.v2'
export interface Workspace {
  rules: Rule[]
  target: TargetId
  policyName: string
  nsxProject?: string
  nsxCategory?: string
  sections?: SectionState
}

export const serializeWorkspace = (state: Workspace): string => JSON.stringify({
  version: 3, rules: state.rules, target: state.target, policyName: state.policyName,
  nsxProject: state.nsxProject, nsxCategory: state.nsxCategory,
  sections: serializeSections(state.rules, state.sections),
})

export function loadWorkspace(storage: Pick<Storage, 'getItem'>): Workspace & { sections: SectionState; warnings: string[]; canSave: boolean } {
  const fallback = { rules: [], target: 'nsx' as const, policyName: 'generated', sections: emptySections(), warnings: [] as string[], canSave: true }
  try {
    const current = storage.getItem(WORKSPACE_KEY)
    const raw = current ?? storage.getItem(LEGACY_WORKSPACE_KEY)
    if (raw === null) return fallback
    const data = JSON.parse(raw) as Record<string, unknown> | null
    if (current && data?.version !== 3)
      return { ...fallback, canSave: false, warnings: ['Unsupported saved workspace version. Saved data is left untouched; export any new work before changing or clearing browser storage.'] }
    if (!data || !Array.isArray(data.rules))
      return { ...fallback, canSave: false, warnings: ['Saved workspace has an invalid rule list. Saved data is left untouched; restore a JSON export/share link or review browser storage.'] }
    const ids = new Set<string>()
    const sourceIndexes: number[] = []
    const rules = data.rules.flatMap((value: unknown, index: number) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return []
      sourceIndexes.push(index)
      const item = value as Partial<Rule>
      const id = typeof item.id === 'string' && item.id && !Object.hasOwn(Object.prototype, item.id) && !ids.has(item.id) ? item.id : newId()
      ids.add(id)
      return [{ ...blankRule(), ...item, id }]
    })
    const restored = restoreSections(current ? data.sections ?? null : undefined, rules, sourceIndexes, data.rules.length)
    return {
      rules, target: TARGETS.some((target) => target.id === data.target) ? data.target as TargetId : 'nsx',
      policyName: typeof data.policyName === 'string' ? data.policyName : 'generated',
      nsxProject: typeof data.nsxProject === 'string' ? data.nsxProject : '',
      nsxCategory: normalizeNsxCategory(typeof data.nsxCategory === 'string' ? data.nsxCategory : undefined),
      ...restored, canSave: true,
    }
  } catch {
    return { ...fallback, warnings: ['Saved workspace could not be read. The workspace is empty; review browser storage or restore a JSON export/share link.'], canSave: false }
  }
}
