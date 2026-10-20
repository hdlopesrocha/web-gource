// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIVE_FFT_SIZE, LiveBandAnalyzer, silentLevels, type AudioLevels } from '../src/engine/audio/analysis'
import { MicrophoneSource } from '../src/engine/audio/microphone'
import { controller } from '../src/engine/controller'
import { resetRunState, store } from '../src/state/store'

/**
 * Microphone capture is real-time Web Audio plus a browser permission prompt,
 * so these tests replace both with deterministic fakes: a fake AudioContext
 * whose nodes just record their connections, and a fake `getUserMedia`.
 *
 * The streaming band analysis is pure DSP and is tested with synthetic PCM
 * through the same band definitions the batch analysis uses.
 */

const RATE = 48_000
const WINDOW = 1024

/* ------------------------------------------------------------------ *
 * Fake Web Audio + media stream
 * ------------------------------------------------------------------ */

class FakeTrack {
  stopped = false
  readyState = 'live'
  stop(): void {
    this.stopped = true
    this.readyState = 'ended'
  }
}

class FakeMediaStream {
  readonly tracks: FakeTrack[]
  constructor(count = 1) {
    this.tracks = Array.from({ length: count }, () => new FakeTrack())
  }
  getTracks(): FakeTrack[] {
    return this.tracks
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks
  }
}

class FakeNode {
  readonly outputs: FakeNode[] = []
  connect(target: FakeNode): FakeNode {
    this.outputs.push(target)
    return target
  }
  disconnect(target?: FakeNode): void {
    if (!target) {
      this.outputs.length = 0
      return
    }
    const index = this.outputs.indexOf(target)
    if (index >= 0) this.outputs.splice(index, 1)
  }
}

class FakeGainNode extends FakeNode {
  readonly gain = { value: 1 }
}

class FakeAnalyserNode extends FakeNode {
  fftSize = 2048
  smoothingTimeConstant = 1
  /** Time-domain samples served by the next read. */
  samples: Float32Array = new Float32Array(WINDOW)
  getFloatTimeDomainData(target: Float32Array): void {
    target.fill(0)
    target.set(this.samples.subarray(0, Math.min(target.length, this.samples.length)))
  }
}

class FakeSourceNode extends FakeNode {
  constructor(readonly stream: FakeMediaStream) {
    super()
  }
}

class FakeDestinationNode extends FakeNode {
  readonly stream = new FakeMediaStream()
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  state = 'running'
  sampleRate = RATE
  readonly destination = new FakeNode()
  readonly sources: FakeSourceNode[] = []
  readonly gains: FakeGainNode[] = []
  readonly analysers: FakeAnalyserNode[] = []
  readonly destinations: FakeDestinationNode[] = []

  constructor() {
    FakeAudioContext.instances.push(this)
  }

  createMediaStreamSource(stream: FakeMediaStream): FakeSourceNode {
    const node = new FakeSourceNode(stream)
    this.sources.push(node)
    return node
  }
  createGain(): FakeGainNode {
    const node = new FakeGainNode()
    this.gains.push(node)
    return node
  }
  createAnalyser(): FakeAnalyserNode {
    const node = new FakeAnalyserNode()
    this.analysers.push(node)
    return node
  }
  createMediaStreamDestination(): FakeDestinationNode {
    const node = new FakeDestinationNode()
    this.destinations.push(node)
    return node
  }
  resume(): Promise<void> {
    this.state = 'running'
    return Promise.resolve()
  }
  close(): Promise<void> {
    this.state = 'closed'
    return Promise.resolve()
  }
}

const globals = globalThis as unknown as { AudioContext?: unknown }

/** Install the fake `AudioContext` (jsdom has no Web Audio at all). */
function installAudioContext(): void {
  globals.AudioContext = FakeAudioContext
}

/** Replace `navigator.mediaDevices.getUserMedia` for this test. */
function installMediaDevices(stream: FakeMediaStream | null, failure?: unknown): ReturnType<typeof vi.fn> {
  const getUserMedia = failure
    ? vi.fn(async () => {
        throw failure
      })
    : vi.fn(async () => stream)
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
  return getUserMedia
}

/* ------------------------------------------------------------------ *
 * Audio fixtures
 * ------------------------------------------------------------------ */

function tone(frequency: number, amplitude = 0.6): Float32Array {
  const samples = new Float32Array(WINDOW)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * frequency * index) / RATE) * amplitude
  }
  return samples
}

function noiseBursts(starts: number[], seconds = 1): Float32Array {
  const samples = new Float32Array(Math.round(seconds * RATE))
  let seed = 1234567
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return (seed / 0xffffffff) * 2 - 1
  }
  for (const start of starts) {
    const first = Math.round(start * RATE)
    const length = Math.round(0.02 * RATE)
    for (let index = 0; index < length; index += 1) {
      samples[first + index] = random() * 0.55 * Math.sin((Math.PI * index) / length)
    }
  }
  return samples
}

/** A complete HUD state: `store.hud` is typed, so every field is filled in. */
function hudAt(time: number, duration: number): NonNullable<typeof store.hud> {
  return {
    time,
    duration,
    date: 0,
    index: 0,
    total: 1,
    playing: true,
    speed: 1,
    commit: null,
    activeAuthors: [],
    visibleFiles: 0,
    visibleDirs: 0,
    totalFiles: 0,
    sizeMode: 'bytes',
    filesWithSize: 0,
    totalBytes: 0,
    additions: 0,
    deletions: 0,
    fps: 60,
    recording: false,
  }
}

beforeEach(() => {
  localStorage.clear()
  controller.backToLanding()
  resetRunState()
  store.music.source = 'file'
  store.music.error = null
  store.music.volume = 0.7
  store.music.fadeInSeconds = 2
  store.music.fadeOutSeconds = 2
  store.settings.audioReactive = true
  FakeAudioContext.instances = []
  installAudioContext()
})

afterEach(() => {
  controller.backToLanding()
  vi.restoreAllMocks()
  delete globals.AudioContext
  delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices
})

/* ------------------------------------------------------------------ *
 * LiveBandAnalyzer
 * ------------------------------------------------------------------ */

describe('LiveBandAnalyzer', () => {
  it('isolates a 100 Hz sine in the bass band', () => {
    const analyzer = new LiveBandAnalyzer()
    const levels = silentLevels()
    for (let index = 0; index < 30; index += 1) analyzer.process(tone(100), RATE, levels)
    expect(levels.bass).toBeGreaterThan(0.8)
    expect(levels.low).toBeLessThan(0.3)
    expect(levels.mid).toBeLessThan(0.2)
    expect(levels.voice).toBeLessThan(0.2)
  })

  it('puts a 2 kHz tone in the mid band', () => {
    const analyzer = new LiveBandAnalyzer()
    const levels = silentLevels()
    for (let index = 0; index < 30; index += 1) analyzer.process(tone(2_000), RATE, levels)
    expect(levels.mid).toBeGreaterThan(0.8)
    expect(levels.bass).toBeLessThan(0.1)
    expect(levels.low).toBeLessThan(0.1)
    // 2 kHz sits in the voice range as well.
    expect(levels.voice).toBeGreaterThan(0.8)
  })

  it('detects noise-burst claps and counts the onsets', () => {
    const analyzer = new LiveBandAnalyzer()
    const samples = noiseBursts([0.1, 0.3])
    const levels = silentLevels()
    let countBeforeFirstBurst = -1
    let peak = 0
    let frames = 0

    for (let offset = 0; offset + WINDOW <= samples.length; offset += WINDOW) {
      analyzer.process(samples.subarray(offset, offset + WINDOW), RATE, levels)
      frames += 1
      // The first burst starts at 0.1 s: four frames of ~21 ms are quiet.
      if (frames === 4) countBeforeFirstBurst = levels.clapCount
      if (levels.clap > peak) peak = levels.clap
    }

    expect(countBeforeFirstBurst).toBe(0)
    expect(peak).toBeGreaterThan(0.3)
    expect(levels.clapCount).toBe(2)
    // Both envelopes have decayed by the end of the second.
    expect(levels.clap).toBeLessThan(0.1)
  })

  it('stays silent for digital silence', () => {
    const analyzer = new LiveBandAnalyzer()
    const levels = analyzer.process(new Float32Array(WINDOW), RATE, silentLevels())
    expect(levels).toEqual({ bass: 0, low: 0, mid: 0, voice: 0, clap: 0, clapCount: 0 })
  })

  it('resets the smoothing and the clap count', () => {
    const analyzer = new LiveBandAnalyzer()
    const levels = silentLevels()
    analyzer.process(tone(100), RATE, levels)
    analyzer.process(noiseBursts([0]).subarray(0, WINDOW), RATE, levels)
    expect(levels.bass).toBeGreaterThan(0)
    analyzer.reset()
    analyzer.process(new Float32Array(WINDOW), RATE, levels)
    expect(levels).toEqual({ bass: 0, low: 0, mid: 0, voice: 0, clap: 0, clapCount: 0 })
  })
})

/* ------------------------------------------------------------------ *
 * MicrophoneSource
 * ------------------------------------------------------------------ */

describe('MicrophoneSource', () => {
  it('starts the capture graph and stops every track on stop', async () => {
    const stream = new FakeMediaStream()
    const getUserMedia = installMediaDevices(stream)
    const microphone = new MicrophoneSource()

    expect(microphone.running).toBe(false)
    await microphone.start()
    expect(microphone.running).toBe(true)
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })

    const context = FakeAudioContext.instances.at(-1)
    expect(context).toBeDefined()
    const source = context!.sources[0]
    const gain = context!.gains[0]
    const analyser = context!.analysers[0]
    const destination = context!.destinations[0]
    // source -> gain -> analyser, and gain -> the recording tap.
    expect(source.outputs).toContain(gain)
    expect(gain.outputs).toContain(analyser)
    expect(gain.outputs).toContain(destination)
    expect(analyser.fftSize).toBe(LIVE_FFT_SIZE)
    expect(analyser.smoothingTimeConstant).toBe(0)
    // Nothing reaches the speakers: monitoring a live microphone feeds back.
    const nodes = [...context!.sources, ...context!.gains, ...context!.analysers, ...context!.destinations]
    expect(nodes.some((node) => node.outputs.includes(context!.destination))).toBe(false)

    expect(microphone.captureStream()).toBe(destination.stream)
    expect(microphone.captureStream()!.getAudioTracks()).toHaveLength(1)

    microphone.stop()
    expect(microphone.running).toBe(false)
    expect(stream.getTracks()).toHaveLength(1)
    expect(stream.getTracks().every((track) => track.stopped)).toBe(true)
    expect(stream.getTracks().every((track) => track.readyState === 'ended')).toBe(true)
    expect(context!.state).toBe('closed')
    expect(gain.outputs).toHaveLength(0)
    expect(microphone.captureStream()).toBeNull()

    // release/dispose are the same teardown and stay safe when called twice.
    microphone.release()
    microphone.dispose()
    expect(microphone.running).toBe(false)
  })

  it('replaces a capture destination whose track the recorder stopped', async () => {
    installMediaDevices(new FakeMediaStream())
    const microphone = new MicrophoneSource()
    await microphone.start()
    const context = FakeAudioContext.instances.at(-1)!

    const first = microphone.captureStream()!
    // The recorder stops the audio track when a take ends.
    for (const track of first.getTracks()) track.stop()

    const second = microphone.captureStream()
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    expect(second!.getAudioTracks()[0]?.readyState).toBe('live')
    // The exhausted destination was replaced, the microphone keeps running.
    expect(microphone.running).toBe(true)
    expect(context.destinations).toHaveLength(2)
    expect(context.gains[0].outputs).not.toContain(context.destinations[0])
    expect(context.gains[0].outputs).toContain(context.destinations[1])
  })

  it('writes a clamped fade into the gain node', async () => {
    installMediaDevices(new FakeMediaStream())
    const microphone = new MicrophoneSource()
    await microphone.start()
    const gain = FakeAudioContext.instances.at(-1)!.gains[0]

    microphone.setFade(0.25)
    expect(gain.gain.value).toBe(0.25)
    microphone.setFade(2)
    expect(gain.gain.value).toBe(1)
    microphone.setFade(-3)
    expect(gain.gain.value).toBe(0)
    microphone.setFade(Number.NaN)
    expect(gain.gain.value).toBe(0)
  })

  it('reads live bands from the analyser and goes silent when stopped', async () => {
    installMediaDevices(new FakeMediaStream())
    const microphone = new MicrophoneSource()
    await microphone.start()
    const analyser = FakeAudioContext.instances.at(-1)!.analysers[0]
    analyser.samples = tone(100)

    const levels = silentLevels()
    for (let index = 0; index < 30; index += 1) microphone.readLevels(levels)
    expect(levels.bass).toBeGreaterThan(0.8)
    expect(levels.mid).toBeLessThan(0.2)

    microphone.stop()
    microphone.readLevels(levels)
    expect(levels).toEqual({ bass: 0, low: 0, mid: 0, voice: 0, clap: 0, clapCount: 0 })
  })

  it('throws without touching the audio graph when permission is denied', async () => {
    const denied = Object.assign(new Error('permission denied'), { name: 'NotAllowedError' })
    installMediaDevices(null, denied)
    const microphone = new MicrophoneSource()
    await expect(microphone.start()).rejects.toThrow('permission denied')
    expect(microphone.running).toBe(false)
    expect(FakeAudioContext.instances).toHaveLength(0)
    expect(microphone.captureStream()).toBeNull()
  })

  it('stops the granted stream when the graph cannot be built', async () => {
    const stream = new FakeMediaStream()
    installMediaDevices(stream)
    class BrokenAudioContext extends FakeAudioContext {
      override createGain(): FakeGainNode {
        throw new Error('no gain today')
      }
    }
    globals.AudioContext = BrokenAudioContext
    const microphone = new MicrophoneSource()
    await expect(microphone.start()).rejects.toThrow('no gain today')
    expect(microphone.running).toBe(false)
    expect(stream.getTracks().every((track) => track.stopped)).toBe(true)
    expect(FakeAudioContext.instances.at(-1)?.state).toBe('closed')
  })
})

/* ------------------------------------------------------------------ *
 * Controller integration
 * ------------------------------------------------------------------ */

describe('controller audio source', () => {
  const internals = controller as unknown as {
    microphone: MicrophoneSource
    audioLevelsFor: (mode: 'live' | 'export', videoTime: number) => AudioLevels | null
  }

  it('switches to the microphone and back to the file', async () => {
    installMediaDevices(new FakeMediaStream())
    await controller.setAudioSource('microphone')
    expect(store.music.source).toBe('microphone')
    expect(store.music.error).toBeNull()
    expect(internals.microphone.running).toBe(true)

    await controller.setAudioSource('file')
    expect(store.music.source).toBe('file')
    expect(internals.microphone.running).toBe(false)
    const context = FakeAudioContext.instances.at(-1)!
    expect(context.state).toBe('closed')
    // The second switch is a harmless no-op.
    await controller.setAudioSource('file')
    expect(internals.microphone.running).toBe(false)
  })

  it('reports a denied microphone and leaves the file selected', async () => {
    const denied = Object.assign(new Error('permission denied'), { name: 'NotAllowedError' })
    installMediaDevices(null, denied)
    await controller.setAudioSource('microphone')
    expect(store.music.source).toBe('file')
    expect(store.music.error).toMatch(/denied/i)
    expect(internals.microphone.running).toBe(false)
  })

  it('closes the microphone when the stage is left', async () => {
    installMediaDevices(new FakeMediaStream())
    await controller.setAudioSource('microphone')
    controller.backToLanding()
    expect(internals.microphone.running).toBe(false)
    expect(store.music.source).toBe('file')
  })

  it('reads live bands with the fade and returns no export bands in microphone mode', async () => {
    installMediaDevices(new FakeMediaStream())
    await controller.setAudioSource('microphone')
    const context = FakeAudioContext.instances.at(-1)!
    context.analysers[0].samples = tone(100)

    store.settings.audioReactive = true
    store.music.volume = 0.8
    store.hud = hudAt(1, 10)

    let live: AudioLevels | null = null
    for (let index = 0; index < 12; index += 1) live = internals.audioLevelsFor('live', 0)
    expect(live).not.toBeNull()
    // Half of the two-second fade-in.
    expect(live!.bass).toBeGreaterThan(0.4)
    expect(live!.bass).toBeLessThan(0.6)
    expect(live!.mid).toBeLessThan(0.2)
    // Live audio cannot be captured deterministically.
    expect(internals.audioLevelsFor('export', 0)).toBeNull()

    // At the very start of the timeline the envelope is still silent.
    store.hud = hudAt(0, 10)
    expect(internals.audioLevelsFor('live', 0)).toBeNull()

    // The gain node follows the same envelope scaled by the volume.
    expect(context.gains[0].gain.value).toBeCloseTo(0, 5)
    store.hud = hudAt(1, 10)
    internals.audioLevelsFor('live', 0)
    expect(context.gains[0].gain.value).toBeCloseTo(0.4, 5)
  })

  it('keeps updating the microphone gain while the reactive visuals are off', async () => {
    installMediaDevices(new FakeMediaStream())
    await controller.setAudioSource('microphone')
    const gain = FakeAudioContext.instances.at(-1)!.gains[0]

    store.settings.audioReactive = false
    store.music.volume = 0.8
    store.hud = hudAt(1, 10)
    expect(internals.audioLevelsFor('live', 0)).toBeNull()
    expect(gain.gain.value).toBeCloseTo(0.4, 5)

    // The end of the animation fades the microphone out as well.
    store.hud = hudAt(9, 10)
    expect(internals.audioLevelsFor('live', 0)).toBeNull()
    expect(gain.gain.value).toBeCloseTo(0.4, 5)
  })
})
