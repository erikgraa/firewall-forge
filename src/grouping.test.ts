import { describe, expect, it } from 'vitest'
import { blankRule } from './model'
import { demoRules, initialMembership, mergePrevious, sectionRuns, splitAt } from './grouping'
import type { Membership } from './grouping'

const rules = Object.freeze(Array.from({ length: 6 }, (_, index) => Object.freeze({ ...blankRule(), id: `r${index}`, name: `rule-${index}`, enabled: index !== 2 }))) as unknown as ReturnType<typeof demoRules>
const membership = Object.freeze({ r0: 'a', r1: 'a', r2: 'a', r3: 'b', r4: 'b', r5: 'b' })
const ids = (input: typeof rules, groups: Membership = membership) => sectionRuns(input, groups).flatMap((run) => run.entries.map(({ rule }) => rule.id))

describe('preview-only contiguous sections', () => {
  it('renders every rule including disabled rules once, in the original order and with global indices', () => {
    const runs = sectionRuns(rules, membership)
    expect(ids(rules)).toEqual(rules.map((rule) => rule.id))
    expect(runs.flatMap((run) => run.entries.map(({ index }) => index))).toEqual([0, 1, 2, 3, 4, 5])
    expect(runs[0].entries[2].rule).toBe(rules[2])
    expect(runs[0].entries[2].rule.enabled).toBe(false)
  })
  it('splits only the contiguous remainder without mutating rules or original membership', () => {
    const next = splitAt(rules, membership, 'r1', 'new')
    expect(next).toEqual({ r0: 'a', r1: 'new', r2: 'new', r3: 'b', r4: 'b', r5: 'b' })
    expect(membership.r1).toBe('a')
    expect(ids(rules, next)).toEqual(rules.map((rule) => rule.id))
  })
  it('merges adjacent sections without reordering their rules', () => {
    const next = mergePrevious(rules, membership, 'r3')
    expect(sectionRuns(rules, next)).toHaveLength(1)
    expect(ids(rules, next)).toEqual(rules.map((rule) => rule.id))
    expect(mergePrevious(rules, membership, 'r0')).toBe(membership)
  })
  it('keeps surviving membership after deleting the original section anchor', () => {
    const remaining = rules.filter((rule) => rule.id !== 'r3')
    expect(sectionRuns(remaining, membership).map((run) => [run.key, run.group])).toEqual([['r0', 'a'], ['r4', 'b']])
    expect(ids(remaining)).toEqual(['r0', 'r1', 'r2', 'r4', 'r5'])
  })
  it('shows disjoint membership as continued sections rather than sorting across explicit moves', () => {
    const moved = [rules[0], rules[3], rules[1], rules[2], rules[4], rules[5]]
    const runs = sectionRuns(moved, membership)
    expect(runs.map((run) => run.continued)).toEqual([false, false, true, true])
    expect(ids(moved)).toEqual(['r0', 'r3', 'r1', 'r2', 'r4', 'r5'])
  })
  it('includes new and imported rules in unsectioned runs, including empty and stale selections', () => {
    const appended = [...rules, { ...blankRule(), id: 'new' }]
    expect(sectionRuns(appended, membership).at(-1)?.group).toBe('unsectioned')
    expect(sectionRuns([], membership)).toEqual([])
    expect(splitAt(rules, membership, 'missing', 'new')).toBe(membership)
    expect(mergePrevious(rules, membership, 'missing')).toBe(membership)
  })
  it('provides 30 valid named demo rules with five sections and no grouping fields in rule data', () => {
    const demo = demoRules()
    expect(demo).toHaveLength(30)
    expect(new Set(demo.map((rule) => rule.id)).size).toBe(30)
    expect(sectionRuns(demo, initialMembership(demo))).toHaveLength(5)
    expect(demo.every((rule) => !('group' in rule) && !('section' in rule))).toBe(true)
  })
})
