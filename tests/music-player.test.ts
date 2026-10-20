// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackgroundMusic, type MusicClockState } from '../src/engine/audio/music'

/**
 * Live background music: JS dom has no real audio decoder, so a small fake
 * element records the `currentTime` writes made when the timeline is seeked.
 */

type FakeAudio = HTMLAudioElement & { emit(type: string): void }

function fakeAudio(duration = 30): FakeAudio {
  const listeners = new Map<string, EventListener>()
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
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners.set(type, listener)
    }),
    removeEventListener: vi.fn((type: string) => {
      listeners.delete(type)
    }),
    emit(type: string) {
      listeners.get(type)?.(new Event(type))
    },
  } as unknown as FakeAudio
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

  it('loops the track', () => {
    expect(element.loop).toBe(true)
  })

  it('restarts the track if the browser reports the end instead of looping', () => {
    state = clock({ playing: true })
    player.sync()
    element.currentTime = 29

    ;(element as FakeAudio).emit('ended')

    expect(element.currentTime).toBe(0)
    expect(element.play).toHaveBeenCalledTimes(2)
  })
})
