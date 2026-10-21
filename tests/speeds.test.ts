import { describe, expect, it } from 'vitest'
import { PLAYBACK_SPEEDS, nextPlaybackSpeed } from '../src/engine/speeds'

describe('playback speeds', () => {
  it('offers the same ordered presets to every playback control', () => {
    expect([...PLAYBACK_SPEEDS]).toEqual([0.25, 0.5, 1, 2, 4, 8, 16, 32])
  })

  it('advances to the next preset and wraps after the fastest', () => {
    expect(nextPlaybackSpeed(0.25)).toBe(0.5)
    expect(nextPlaybackSpeed(1)).toBe(2)
    expect(nextPlaybackSpeed(16)).toBe(32)
    expect(nextPlaybackSpeed(32)).toBe(0.25)
  })

  it('snaps a custom rate to the next preset above it', () => {
    expect(nextPlaybackSpeed(0.1)).toBe(0.25)
    expect(nextPlaybackSpeed(3)).toBe(4)
    expect(nextPlaybackSpeed(100)).toBe(0.25)
  })
})
