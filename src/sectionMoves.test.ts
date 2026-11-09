import { describe, expect, it } from 'vitest'
import { blankRule } from './model'
import type { Rule } from './model'
import type { Membership } from './grouping'
import { appendToUnsectioned, moveRuleToSection, reorderRuleWithinSection } from './sectionMoves'

const rules = Object.freeze(Array.from({ length: 6 }, (_, index) => Object.freeze({ ...blankRule(), id: `r${index}`, name: `Rule ${index}`, notes: `Keep ${index}`, enabled: index !== 2 }))) as unknown as Rule[]
const membership = Object.freeze({ r0: 'a', r1: 'a', r2: 'b', r3: 'b', r4: 'unsectioned', r5: 'c' })
const ids = (input: Rule[]) => input.map((rule) => rule.id)

describe('section evaluation moves', () => {
  it.each([
    ['r0', 'b', ['r1', 'r2', 'r3', 'r0', 'r4', 'r5'], 0, 3],
    ['r5', 'a', ['r0', 'r1', 'r5', 'r2', 'r3', 'r4'], 5, 2],
    ['r0', 'a', ['r1', 'r0', 'r2', 'r3', 'r4', 'r5'], 0, 1],
    ['r1', 'a', ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'], 1, 1],
    ['r2', 'empty', ['r0', 'r1', 'r3', 'r4', 'r5', 'r2'], 2, 5],
    ['r5', 'c', ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'], 5, 5],
    ['r0', 'unsectioned', ['r1', 'r2', 'r3', 'r4', 'r0', 'r5'], 0, 4],
  ])('moves %s to the end of %s after removing it', (ruleId, groupId, expected, fromIndex, toIndex) => {
    const moved = moveRuleToSection(rules, membership, ruleId, groupId)
    expect(ids(moved.rules)).toEqual(expected)
    expect(moved.fromIndex).toBe(fromIndex)
    expect(moved.toIndex).toBe(toIndex)
    expect(moved.membership).toEqual({ ...membership, [ruleId]: groupId })
    expect(moved.rules[toIndex]).toBe(rules[fromIndex])
    expect(moved.rules[toIndex].enabled).toBe(rules[fromIndex].enabled)
    expect(moved.rules[toIndex].notes).toBe(rules[fromIndex].notes)
  })

  it('preserves every other object, order and membership for every source/destination combination', () => {
    for (const source of rules) for (const target of ['a', 'b', 'c', 'unsectioned', 'empty']) {
      const moved = moveRuleToSection(rules, membership, source.id, target)
      expect(moved.rules.filter((rule) => rule.id !== source.id)).toEqual(rules.filter((rule) => rule.id !== source.id))
      expect(new Set(ids(moved.rules)).size).toBe(rules.length)
      for (const rule of moved.rules) {
        expect(rule).toBe(rules.find((original) => original.id === rule.id))
        if (rule.id !== source.id) expect(moved.membership[rule.id]).toBe(membership[rule.id as keyof typeof membership])
      }
    }
    expect(ids(rules)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5'])
    expect(membership.r0).toBe('a')
  })

  it('uses the last disjoint destination member without consolidating other rules', () => {
    const moved = moveRuleToSection(rules, { r0: 'a', r1: 'b', r2: 'a', r3: 'b', r4: 'a', r5: 'c' }, 'r1', 'a')
    expect(ids(moved.rules)).toEqual(['r0', 'r2', 'r3', 'r4', 'r1', 'r5'])
  })

  it('treats absent and inherited membership as Unsectioned', () => {
    const inherited: Membership = Object.create({ r1: 'a', r5: 'a' })
    inherited.r0 = 'a'
    expect(ids(moveRuleToSection(rules, inherited, 'r0', 'unsectioned').rules)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r0'])
    expect(ids(moveRuleToSection(rules, {}, 'r5', 'a').rules)).toEqual(ids(rules))
  })

  it('safely copies a prototype-named rule ID as its own property', () => {
    const unusual = [{ ...blankRule(), id: '__proto__' }]
    const result = moveRuleToSection(unusual, {}, '__proto__', 'a')
    expect(Object.hasOwn(result.membership, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(result.membership)).toBe(Object.prototype)
    expect(result.membership['__proto__']).toBe('a')
  })

  it.each([['missing', 'a'], ['r0', ''], ['r0', '   ']])('returns safe no-op indices for %s / %s', (id, group) => {
    const moved = moveRuleToSection(rules, membership, id, group)
    expect(moved).toEqual({ rules, membership, fromIndex: -1, toIndex: -1 })
    expect(moved.rules).toBe(rules)
    expect(moved.membership).toBe(membership)
    expect(moveRuleToSection([], {}, id, group).fromIndex).toBe(-1)
  })
})

describe('adding to Unsectioned without sorting existing rules', () => {
  const added = Object.freeze([{ ...blankRule(), id: 'new-first' }, { ...blankRule(), id: 'new-disabled', enabled: false }].map(Object.freeze)) as unknown as Rule[]
  it('inserts a recipe batch after the last Unsectioned rule, before later named sections', () => {
    const result = appendToUnsectioned(rules, added, membership)
    expect(ids(result)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'new-first', 'new-disabled', 'r5'])
    expect(result.filter((rule) => !added.includes(rule))).toEqual(rules)
    expect(result[5]).toBe(added[0])
    expect(result[6]).toBe(added[1])
    expect(result[6].enabled).toBe(false)
    expect(Object.hasOwn(membership, 'new-first')).toBe(false)
  })
  it('uses implicit Unsectioned and preserves disjoint runs', () => {
    expect(ids(appendToUnsectioned(rules, added, { r1: 'a', r3: 'b', r5: 'c' }))).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'new-first', 'new-disabled', 'r5'])
    expect(ids(appendToUnsectioned(rules, added, {}))).toEqual([...ids(rules), ...ids(added)])
  })
  it('appends to a fully sectioned or empty list, and handles an empty batch', () => {
    const allSectioned = Object.fromEntries(rules.map((rule) => [rule.id, 'a']))
    expect(appendToUnsectioned(rules, added, allSectioned)).toEqual([...rules, ...added])
    expect(appendToUnsectioned([], added, {})).toEqual(added)
    expect(appendToUnsectioned(rules, [], membership)).toEqual(rules)
    expect(appendToUnsectioned([], [], {})).toEqual([])
  })
  it('ignores inherited membership when locating Unsectioned', () => {
    expect(appendToUnsectioned(rules, added, Object.create({ r5: 'a' }))).toEqual([...rules, ...added])
  })
})

describe('within-section row placement', () => {
  const sameGroup = Object.freeze(Object.fromEntries(rules.map((rule) => [rule.id, 'a'])))
  it.each([
    ['r4', 'r1', 'before', ['r0', 'r4', 'r1', 'r2', 'r3', 'r5'], 4, 1],
    ['r1', 'r4', 'after', ['r0', 'r2', 'r3', 'r4', 'r1', 'r5'], 1, 4],
    ['r2', 'r1', 'before', ['r0', 'r2', 'r1', 'r3', 'r4', 'r5'], 2, 1],
    ['r0', 'r5', 'after', ['r1', 'r2', 'r3', 'r4', 'r5', 'r0'], 0, 5],
    ['r5', 'r0', 'before', ['r5', 'r0', 'r1', 'r2', 'r3', 'r4'], 5, 0],
  ] as const)('places %s %s %s with original objects and unchanged membership', (source, anchor, placement, expected, fromIndex, toIndex) => {
    const result = reorderRuleWithinSection(rules, sameGroup, source, anchor, placement)
    expect(ids(result.rules)).toEqual(expected)
    expect(result.fromIndex).toBe(fromIndex)
    expect(result.toIndex).toBe(toIndex)
    expect(result.rules[toIndex]).toBe(rules[fromIndex])
    expect(result.rules.filter((rule) => rule.id !== source)).toEqual(rules.filter((rule) => rule.id !== source))
    for (const rule of result.rules) expect(rule).toBe(rules.find((original) => original.id === rule.id))
    expect(sameGroup).toEqual(Object.fromEntries(rules.map((rule) => [rule.id, 'a'])))
    expect(result.rules.find((rule) => rule.id === 'r2')?.enabled).toBe(false)
  })
  it.each([['missing', 'r1'], ['r1', 'missing'], ['r0', 'r0'], ['r0', 'r2'], ['r1', 'r5']])('rejects missing/self/different-group IDs %s / %s', (source, anchor) => {
    expect(reorderRuleWithinSection(rules, membership, source, anchor, 'before')).toEqual({ rules, fromIndex: -1, toIndex: -1 })
  })
  it('rejects separate continued runs of the same group without consolidating them', () => {
    const continued = Object.freeze({ r0: 'a', r1: 'a', r2: 'b', r3: 'a', r4: 'a', r5: 'a' })
    expect(reorderRuleWithinSection(rules, continued, 'r0', 'r4', 'after')).toEqual({ rules, fromIndex: -1, toIndex: -1 })
    expect(ids(reorderRuleWithinSection(rules, continued, 'r4', 'r3', 'before').rules)).toEqual(['r0', 'r1', 'r2', 'r4', 'r3', 'r5'])
  })
  it('supports implicit Unsectioned, empty inputs and an already-adjacent placement', () => {
    expect(reorderRuleWithinSection([], {}, 'r0', 'r1', 'before').fromIndex).toBe(-1)
    expect(ids(reorderRuleWithinSection(rules, Object.create({ r2: 'inherited' }), 'r2', 'r1', 'before').rules)).toEqual(['r0', 'r2', 'r1', 'r3', 'r4', 'r5'])
    expect(reorderRuleWithinSection(rules, sameGroup, 'r0', 'r1', 'before').toIndex).toBe(0)
    expect(ids(rules)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5'])
  })
})
