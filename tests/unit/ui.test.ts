import { describe, expect, it } from 'vitest'
import { pickQuestIcon, questIconPath } from '../../src/ui/art/questIcons'

describe('quest item icons (UI concept)', () => {
  it('picks an object that matches the quest title', () => {
    expect(pickQuestIcon('Workout')).toBe('dumbbell')
    expect(pickQuestIcon('Send invoice to client')).toBe('envelope')
    expect(pickQuestIcon('Prep for the meeting')).toBe('calendar')
    expect(pickQuestIcon('Cook a proper meal')).toBe('meal')
    expect(pickQuestIcon('Finish reading ch. 6')).toBe('book')
    expect(pickQuestIcon('Plan next week')).toBe('books')
    expect(pickQuestIcon('Organize your space')).toBe('backpack')
    expect(pickQuestIcon('Morning run 5k')).toBe('shoe')
    expect(pickQuestIcon('Review pull request #42')).toBe('laptop')
    expect(pickQuestIcon('Water the plants')).toBe('watering_can')
    expect(pickQuestIcon('Zzzqx')).toBeNull()
  })
  it('uses the imported icon when the title matches, otherwise the category icon', () => {
    // the icon sheet is imported in this build (src/ui/art/manifest.ts)
    expect(questIconPath({ title: 'Workout', category: 'daily' })).toBe('quest/dumbbell')
    expect(questIconPath({ title: 'Zzzqx', category: 'daily' })).toBe('icons/cat_daily')
    expect(pickQuestIcon('Workout', [])).toBeNull()
  })
})
