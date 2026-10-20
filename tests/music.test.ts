import { describe, expect, it } from 'vitest'
import { fadeGain, musicSourceFromBuffer, renderMusicChunk, type MusicSource } from '../src/engine/audio/music'

/**
 * Background-music maths: the fade envelope and the looping/resampling renderer
 * are shared by live playback and the export, so they are tested without any
 * Web Audio or DOM.
 */

function source(samples: number[], sampleRate = 4, channels = 1): MusicSource {
  const data = new Float32Array(samples)
  return {
    sampleRate,
    numberOfChannels: channels,
    length: data.length,
    channels: [data],
    duration: data.length / sampleRate,
  }
}

describe('fadeGain', () => {
  it('fades in from silence and out to silence at the animation end', () => {
    expect(fadeGain(0, 10, 2, 2)).toBe(0)
    expect(fadeGain(1, 10, 2, 2)).toBeCloseTo(0.5, 10)
    expect(fadeGain(5, 10, 2, 2)).toBe(1)
    expect(fadeGain(9, 10, 2, 2)).toBeCloseTo(0.5, 10)
    expect(fadeGain(10, 10, 2, 2)).toBe(0)
  })

  it('scales the envelope by the requested volume', () => {
    expect(fadeGain(5, 10, 2, 2, 0.4)).toBeCloseTo(0.4, 10)
    expect(fadeGain(1, 10, 2, 2, 0.4)).toBeCloseTo(0.2, 10)
    expect(fadeGain(-1, 10, 2, 2)).toBe(0)
    expect(fadeGain(11, 10, 2, 2)).toBe(0)
  })

  it('disables a fade when its length is zero', () => {
    expect(fadeGain(0, 10, 0, 0, 0.7)).toBeCloseTo(0.7, 10)
    expect(fadeGain(10, 10, 0, 0, 0.7)).toBeCloseTo(0.7, 10)
    expect(fadeGain(0.5, 10, 0, 2)).toBeCloseTo(1, 10)
    expect(fadeGain(9.5, 10, 2, 0)).toBeCloseTo(1, 10)
  })

  it('clamps invalid volumes and times instead of producing NaNs', () => {
    expect(fadeGain(1, 10, 2, 2, Number.NaN)).toBe(0)
    expect(fadeGain(1, 10, 2, 2, 3)).toBeCloseTo(0.5, 10)
    expect(fadeGain(Number.NaN, 10, 2, 2)).toBe(0)
    expect(fadeGain(1, Number.NaN, 2, 2)).toBe(0)
  })
})

describe('renderMusicChunk', () => {
  it('wraps at the end of the track and keeps looping', () => {
    const music = source([0, 1, 2, 3])
    const output = renderMusicChunk(music, 0, 10, {
      sampleRate: 4,
      numberOfChannels: 1,
      duration: 2.5,
      endTime: 10,
      volume: 1,
      fadeInSeconds: 0,
      fadeOutSeconds: 0,
    })
    expect(Array.from(output[0])).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 1])
  })

  it('resamples linearly when the source and output rates differ', () => {
    const music = source([0, 1], 2)
    const output = renderMusicChunk(music, 0, 8, {
      sampleRate: 4,
      numberOfChannels: 1,
      duration: 2,
      endTime: 10,
      volume: 1,
      fadeInSeconds: 0,
      fadeOutSeconds: 0,
    })
    expect(Array.from(output[0])).toEqual([0, 0.5, 1, 0.5, 0, 0.5, 1, 0.5])
  })

  it('applies the envelope in output time, including across a loop', () => {
    const music = source([0.25, 0.25, 0.25, 0.25])
    const output = renderMusicChunk(music, 0, 8, {
      sampleRate: 4,
      numberOfChannels: 1,
      duration: 2,
      endTime: 2,
      volume: 0.5,
      fadeInSeconds: 1,
      fadeOutSeconds: 1,
    })
    // Samples at t = 0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75 s; the envelope
    // is 0.5 * min(t, 2 - t) for this track.
    expect(Array.from(output[0]).map((value) => Math.round(value * 1000) / 1000)).toEqual([
      0, 0.031, 0.063, 0.094, 0.125, 0.094, 0.063, 0.031,
    ])
  })

  it('duplicates mono to stereo and selects the matching source channel', () => {
    const mono = renderMusicChunk(source([0.5]), 0, 2, {
      sampleRate: 4,
      numberOfChannels: 2,
      duration: 1,
      endTime: 10,
      volume: 1,
      fadeInSeconds: 0,
      fadeOutSeconds: 0,
    })
    expect(Array.from(mono[0])).toEqual([0.5, 0.5])
    expect(Array.from(mono[1])).toEqual([0.5, 0.5])

    const stereo: MusicSource = {
      sampleRate: 4,
      numberOfChannels: 2,
      length: 1,
      channels: [new Float32Array([1]), new Float32Array([-1])],
      duration: 0.25,
    }
    const output = renderMusicChunk(stereo, 0, 1, {
      sampleRate: 4,
      numberOfChannels: 2,
      duration: 1,
      endTime: 10,
      volume: 1,
      fadeInSeconds: 0,
      fadeOutSeconds: 0,
    })
    expect(Array.from(output[0])).toEqual([1])
    expect(Array.from(output[1])).toEqual([-1])
  })

  it('returns silent channels for an empty source', () => {
    const empty = source([])
    const output = renderMusicChunk(empty, 0, 3, {
      sampleRate: 4,
      numberOfChannels: 2,
      duration: 1,
      endTime: 10,
      volume: 1,
      fadeInSeconds: 0,
      fadeOutSeconds: 0,
    })
    expect(Array.from(output[0])).toEqual([0, 0, 0])
    expect(Array.from(output[1])).toEqual([0, 0, 0])
  })
})

describe('musicSourceFromBuffer', () => {
  it('keeps mono/stereo channels and folds surround input to stereo', () => {
    const buffer = {
      numberOfChannels: 2,
      length: 2,
      sampleRate: 8,
      duration: 0.25,
      getChannelData: (channel: number) => new Float32Array([channel, channel + 2]),
    } as unknown as AudioBuffer
    const converted = musicSourceFromBuffer(buffer)
    expect(converted.numberOfChannels).toBe(2)
    expect(Array.from(converted.channels[0])).toEqual([0, 2])
    expect(Array.from(converted.channels[1])).toEqual([1, 3])

    const surround = {
      numberOfChannels: 4,
      length: 1,
      sampleRate: 8,
      duration: 0.125,
      getChannelData: (channel: number) => new Float32Array([channel]),
    } as unknown as AudioBuffer
    const folded = musicSourceFromBuffer(surround)
    expect(folded.numberOfChannels).toBe(2)
    expect(Array.from(folded.channels[0])).toEqual([1])
    expect(Array.from(folded.channels[1])).toEqual([2])
  })
})
