import { describe, expect, it } from 'vitest'
import { analyzeMusic, silentLevels } from '../src/engine/audio/analysis'
import type { MusicSource } from '../src/engine/audio/music'

/**
 * The music analysis turns the decoded track into the band envelopes that drive
 * the visualization. These tests use synthetic PCM so the expected band
 * contents are known exactly.
 */

const RATE = 12_000

function source(samples: Float32Array, rate = RATE): MusicSource {
  return {
    sampleRate: rate,
    numberOfChannels: 1,
    length: samples.length,
    channels: [samples],
    duration: samples.length / rate,
  }
}

function tone(frequency: number, seconds = 2, amplitude = 0.6): MusicSource {
  const samples = new Float32Array(Math.round(seconds * RATE))
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * frequency * index) / RATE) * amplitude
  }
  return source(samples)
}

function noiseBursts(bursts: number[], seconds = 2): MusicSource {
  const samples = new Float32Array(Math.round(seconds * RATE))
  let seed = 1234567
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return (seed / 0xffffffff) * 2 - 1
  }
  for (const start of bursts) {
    const first = Math.round(start * RATE)
    const length = Math.round(0.02 * RATE)
    for (let index = 0; index < length; index += 1) {
      const fade = Math.sin((Math.PI * index) / length)
      samples[first + index] = random() * 0.55 * fade
    }
  }
  return source(samples)
}

describe('analyzeMusic', () => {
  it('returns silence for a silent track', () => {
    const analysis = analyzeMusic(source(new Float32Array(RATE * 2)))
    const levels = analysis.sample(1, silentLevels())
    expect(levels.bass).toBe(0)
    expect(levels.low).toBe(0)
    expect(levels.mid).toBe(0)
    expect(levels.voice).toBe(0)
    expect(levels.clap).toBe(0)
    expect(levels.clapCount).toBe(0)
    expect(analysis.frames).toBeGreaterThan(1)
    expect(analysis.duration).toBeCloseTo(2, 5)
  })

  it('puts a low sine in the bass band only', () => {
    const analysis = analyzeMusic(tone(100))
    const levels = analysis.sample(1.5, silentLevels())
    expect(levels.bass).toBeGreaterThan(0.9)
    expect(levels.low).toBeLessThan(0.2)
    expect(levels.mid).toBeLessThan(0.2)
    expect(levels.voice).toBeLessThan(0.2)
  })

  it('puts a mid sine in the folder, line and voice bands', () => {
    const analysis = analyzeMusic(tone(1_000))
    const levels = analysis.sample(1.5, silentLevels())
    expect(levels.bass).toBeLessThan(0.1)
    expect(levels.low).toBeLessThan(0.1)
    expect(levels.mid).toBeGreaterThan(0.8)
    expect(levels.voice).toBeGreaterThan(0.8)
  })

  it('separates bass from the vocal range', () => {
    const analysis = analyzeMusic(tone(250))
    const levels = analysis.sample(1.5, silentLevels())
    expect(levels.low).toBeGreaterThan(0.8)
    expect(levels.voice).toBeLessThan(0.4)
  })

  it('detects claps as decaying transients and counts them', () => {
    const analysis = analyzeMusic(noiseBursts([1, 1.5]))
    const before = analysis.sample(0.9, silentLevels())
    expect(before.clap).toBeLessThan(0.02)
    expect(before.clapCount).toBe(0)

    const first = analysis.sample(1.03, silentLevels())
    expect(first.clap).toBeGreaterThan(0.3)
    expect(first.clapCount).toBe(1)

    const between = analysis.sample(1.4, silentLevels())
    expect(between.clap).toBeLessThan(0.1)
    expect(between.clapCount).toBe(1)

    const second = analysis.sample(1.53, silentLevels())
    expect(second.clapCount).toBe(2)
  })

  it('clamps sampling outside the track and keeps the last clap count', () => {
    const analysis = analyzeMusic(noiseBursts([0.5], 1))
    const start = analysis.sample(-5, silentLevels())
    expect(start.clapCount).toBe(0)
    const end = analysis.sample(100, silentLevels())
    expect(end.clapCount).toBe(1)
    expect(Number.isFinite(end.bass)).toBe(true)
  })

  it('analyses a lower sample rate without exceeding the Nyquist frequency', () => {
    const samples = new Float32Array(8_000)
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.sin((2 * Math.PI * 200 * index) / 8_000) * 0.5
    }
    const analysis = analyzeMusic(source(samples, 8_000))
    const levels = analysis.sample(0.5, silentLevels())
    expect(levels.low).toBeGreaterThan(0.8)
    expect(analysis.hopSeconds).toBeGreaterThan(0.02)
  })
})
