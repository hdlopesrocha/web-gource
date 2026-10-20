// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackgroundMusic, type MusicClockState } from '../src/engine/audio/music'

/**
 * Live background music: JS dom has no real audio decoder, so a small fake
 * element records the `currentTime` writes made when the timeline is seeked.
 */

function fakeAudio(duration = 30): HTMLAudioElement {
  return {
    src: '',
    loop: false,
    preload: '',
    volume: 0,
    currentTime: 0,
    duration,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    removeAttribute: vi.fn(),
    load: vi.fn(),
  } as unknown as HTMLAudioElement
}

function clock(patch: Partial<MusicClockState> = {}): MusicClockState {
  return {
    time: 0,
    duration: 120,
    speed: 1,
    playing: false,
    ...patch,
  }
}

describe('BackgroundMusic', () => {
  let player: BackgroundMusic
  let element: HTMLAudioElement
  let state: MusicClockState

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    element = fakeAudio()
    vi.spyOn(document, 'createElement').mockReturnValue(element)
    player = new BackgroundMusic()
    player.load('blob:test', 30)
    state = clock()
    player.setClock(() => state)
  })

  afterEach(() => {
    player.unload()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('seeks to the matching loop position when paused', () => {
    state = clock({ time: 42 })
    player.sync()
    expect(element.currentTime).toBeCloseTo(12, 10)

    state = clock({ time: 100, speed: 2 })
    player.sync()
    expect(element.currentTime).toBeCloseTo(20, 10)
  })

  it('seeks the playing track without stopping it', () => {
    state = clock({ time: 0, playing: true })
    player.sync()
    expect(player.playing).toBe(true)

    state = clock({ time: 70, playing: true })
    player.sync()
    expect(element.currentTime).toBeCloseTo(10, 10)
    expect(player.playing).toBe(true)
  })

  it('does not nudge audio during normal playback', () => {
    state = clock({ time: 42, playing: true })
    player.sync()
    element.currentTime = 12

    state = clock({ time: 42.1, playing: true })
    player.sync()
    expect(element.currentTime).toBe(12)
  })

  it('seeks to the start when the timeline reaches its end', () => {
    state = clock({ time: 120 })
    player.sync()
    expect(element.currentTime).toBe(0)
  })
})
