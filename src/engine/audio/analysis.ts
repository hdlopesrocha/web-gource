/**
 * Offline frequency analysis of the background track.
 *
 * The uploaded file is decoded with the Web Audio API and then analysed once
 * with a small FFT. Every hop stores how much energy the track has in a handful
 * of bands, so the live view and the deterministic export can animate from the
 * same data (an `AnalyserNode` would only work in real time and would make an
 * export depend on the speed of the machine).
 *
 * The bands map directly onto the visualization:
 *
 *  - bass (25–150 Hz) shifts the hue of the folder glow;
 *  - low mids (150–400 Hz) tint the folder rings;
 *  - midrange (400–2000 Hz) brightens the branch lines;
 *  - the 300–3400 Hz voice range pulses the author avatars;
 *  - short transients in 1800–5800 Hz are detected as claps and cycle the file
 *    colours.
 *
 * The same bands are produced live for the microphone by {@link LiveBandAnalyzer},
 * which runs the same FFT, normalisation and clap detection over streaming
 * windows instead of a whole decoded track.
 */

import type { MusicSource } from './music'

/** Frames per second of the analysis is derived from this rate. */
const ANALYSIS_RATE = 12_000
/** ~43 ms window: long enough to resolve the bass, short enough for claps. */
const FFT_SIZE = 512
/** ~21 ms between frames at 12 kHz. */
const HOP_SIZE = 256

const BASS_BAND: readonly [number, number] = [25, 150]
const LOW_BAND: readonly [number, number] = [150, 400]
const MID_BAND: readonly [number, number] = [400, 2_000]
const VOICE_BAND: readonly [number, number] = [300, 3_400]
const CLAP_BAND: readonly [number, number] = [1_800, 5_800]

/** FFT window of the live (microphone) analyser; its AnalyserNode matches it. */
export const LIVE_FFT_SIZE = 1024

/** Level of each reactive band at a point in the track, all in 0…1. */
export interface AudioLevels {
  /** 25–150 Hz: drives the glow hue. */
  bass: number
  /** 150–400 Hz: drives the folder rings. */
  low: number
  /** 400–2000 Hz: drives the branch lines. */
  mid: number
  /** 300–3400 Hz: drives the author avatars. */
  voice: number
  /** Decaying transient envelope: drives the file colours. */
  clap: number
  /** Number of detected claps up to the sampled moment (for palette cycles). */
  clapCount: number
}

/** A fresh, silent set of levels. */
export function silentLevels(): AudioLevels {
  return { bass: 0, low: 0, mid: 0, voice: 0, clap: 0, clapCount: 0 }
}

/**
 * Precomputed energy envelopes for one track.
 *
 * Arrays are indexed by analysis frame; {@link sample} interpolates between two
 * frames and is what the render loop calls every animation frame.
 */
export class AudioAnalysis {
  readonly frames: number
  readonly duration: number
  readonly hopSeconds: number
  readonly bass: Float32Array
  readonly low: Float32Array
  readonly mid: Float32Array
  readonly voice: Float32Array
  readonly clap: Float32Array
  readonly clapCount: Uint32Array

  constructor(options: {
    duration: number
    hopSeconds: number
    bass: Float32Array
    low: Float32Array
    mid: Float32Array
    voice: Float32Array
    clap: Float32Array
    clapCount: Uint32Array
  }) {
    this.duration = options.duration
    this.hopSeconds = options.hopSeconds
    this.bass = options.bass
    this.low = options.low
    this.mid = options.mid
    this.voice = options.voice
    this.clap = options.clap
    this.clapCount = options.clapCount
    this.frames = options.bass.length
  }

  /** Number of seconds covered by one frame. */
  get frameRate(): number {
    return 1 / this.hopSeconds
  }

  /**
   * Read all bands at `time` (seconds into the track), interpolating linearly
   * between the neighbouring frames. Values outside the track are clamped.
   */
  sample(time: number, target: AudioLevels = silentLevels()): AudioLevels {
    const safeTime = Number.isFinite(time) ? time : 0
    const position = Math.max(0, Math.min(this.frames - 1, safeTime / this.hopSeconds))
    const first = Math.floor(position)
    const second = Math.min(this.frames - 1, first + 1)
    const blend = position - first
    target.bass = mix(this.bass, first, second, blend)
    target.low = mix(this.low, first, second, blend)
    target.mid = mix(this.mid, first, second, blend)
    target.voice = mix(this.voice, first, second, blend)
    target.clap = mix(this.clap, first, second, blend)
    // The palette uses the latest clap count up to the sampled moment; blending
    // counts would invent half claps.
    target.clapCount = this.clapCount[first] ?? 0
    return target
  }
}

/**
 * Analyse a decoded track once. This is pure DSP over the PCM samples, so it
 * needs no audio context and is identical on every machine.
 */
export function analyzeMusic(source: MusicSource): AudioAnalysis {
  const duration = Math.max(0, source.duration)
  const rate = Math.max(1, Math.min(ANALYSIS_RATE, source.sampleRate || ANALYSIS_RATE))
  const samples = downsampleToMono(source, rate)
  const frames = Math.max(1, Math.ceil(samples.length / HOP_SIZE))
  const hopSeconds = HOP_SIZE / rate

  const rawBass = new Float32Array(frames)
  const rawLow = new Float32Array(frames)
  const rawMid = new Float32Array(frames)
  const rawVoice = new Float32Array(frames)
  const rawClap = new Float32Array(frames)

  const fft = new FFT(FFT_SIZE)
  const window = hannWindow(FFT_SIZE)
  const real = new Float32Array(FFT_SIZE)
  const imaginary = new Float32Array(FFT_SIZE)
  const binWidth = rate / FFT_SIZE
  const nyquistBin = FFT_SIZE / 2 - 1
  const bands = createBandEnergies()

  for (let frame = 0; frame < frames; frame += 1) {
    const center = frame * HOP_SIZE + HOP_SIZE / 2
    const start = center - FFT_SIZE / 2
    for (let index = 0; index < FFT_SIZE; index += 1) {
      const sample = start + index
      real[index] = sample >= 0 && sample < samples.length ? samples[sample] * window[index] : 0
      imaginary[index] = 0
    }
    fft.transform(real, imaginary)
    measureBands(real, imaginary, binWidth, nyquistBin, bands)
    rawBass[frame] = bands.bass
    rawLow[frame] = bands.low
    rawMid[frame] = bands.mid
    rawVoice[frame] = bands.voice
    rawClap[frame] = bands.clap
  }

  // Normalise every band against the loudness of the whole mix, not against
  // itself: a quiet band (or the leakage of a sine into a neighbouring band)
  // must not be blown up to full scale. The gains compensate for the fact that
  // bass carries most of the energy in typical music.
  const total = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    total[frame] = combinedEnergy(rawBass[frame], rawLow[frame], rawMid[frame], rawVoice[frame], rawClap[frame])
  }
  const reference = referenceLevel(total)
  const bass = smoothEnvelope(rawBass, reference, 1.05, 0.55, 0.12)
  const low = smoothEnvelope(rawLow, reference, 1.5, 0.6, 0.16)
  const mid = smoothEnvelope(rawMid, reference, 1.6, 0.6, 0.16)
  const voice = smoothEnvelope(rawVoice, reference, 1.45, 0.22, 0.07)

  const { clap, clapCount } = detectClaps(rawClap, reference, hopSeconds, 1.8)

  return new AudioAnalysis({
    duration,
    hopSeconds,
    bass,
    low,
    mid,
    voice,
    clap,
    clapCount,
  })
}

/** Average the channels and low-pass the result to the analysis rate. */
function downsampleToMono(source: MusicSource, rate: number): Float32Array {
  const channels = source.channels
  const sourceLength = source.length
  if (channels.length === 0 || sourceLength === 0) return new Float32Array(0)
  const ratio = source.sampleRate / rate
  const length = Math.max(1, Math.floor(sourceLength / Math.max(ratio, 1e-6)))
  const mono = new Float32Array(length)
  // A short boxcar suppresses frequencies above the new Nyquist frequency just
  // well enough for a visualizer, without the cost of a proper FIR filter.
  const taps = Math.max(1, Math.round(ratio))
  const offset = Math.floor(taps / 2)

  for (let index = 0; index < length; index += 1) {
    const center = Math.round(index * ratio)
    let sum = 0
    let count = 0
    for (let tap = 0; tap < taps; tap += 1) {
      const position = center - offset + tap
      if (position < 0 || position >= sourceLength) continue
      let sample = 0
      for (const channel of channels) sample += channel[position]
      sum += sample / channels.length
      count += 1
    }
    mono[index] = count > 0 ? sum / count : 0
  }
  return mono
}

/** Energy (sum of squared magnitudes) of one frequency range. */
function bandEnergy(
  real: Float32Array,
  imaginary: Float32Array,
  band: readonly [number, number],
  binWidth: number,
  nyquistBin: number,
): number {
  const first = Math.max(1, Math.ceil(band[0] / binWidth))
  const last = Math.min(nyquistBin, Math.floor(band[1] / binWidth))
  let energy = 0
  for (let bin = first; bin <= last; bin += 1) {
    energy += real[bin] * real[bin] + imaginary[bin] * imaginary[bin]
  }
  return Math.sqrt(energy)
}

/** Raw band energies of one FFT frame. Reused so a stream does not allocate. */
interface BandEnergies {
  bass: number
  low: number
  mid: number
  voice: number
  clap: number
}

/** A fresh, zeroed band container. */
function createBandEnergies(): BandEnergies {
  return { bass: 0, low: 0, mid: 0, voice: 0, clap: 0 }
}

/** Measure the five reactive bands of one transformed FFT frame. */
function measureBands(
  real: Float32Array,
  imaginary: Float32Array,
  binWidth: number,
  nyquistBin: number,
  out: BandEnergies,
): BandEnergies {
  out.bass = bandEnergy(real, imaginary, BASS_BAND, binWidth, nyquistBin)
  out.low = bandEnergy(real, imaginary, LOW_BAND, binWidth, nyquistBin)
  out.mid = bandEnergy(real, imaginary, MID_BAND, binWidth, nyquistBin)
  out.voice = bandEnergy(real, imaginary, VOICE_BAND, binWidth, nyquistBin)
  out.clap = bandEnergy(real, imaginary, CLAP_BAND, binWidth, nyquistBin)
  return out
}

/** Loudness of one frame across all bands (Pythagoras of the raw energies). */
function combinedEnergy(bass: number, low: number, mid: number, voice: number, clap: number): number {
  return Math.sqrt(bass * bass + low * low + mid * mid + voice * voice + clap * clap)
}

/** Scale raw band energy by the reference loudness; pushes quiet bands down. */
function normaliseEnergy(raw: number, reference: number, gain: number): number {
  return Math.min(1.25, gain * Math.sqrt(Math.max(0, raw) / reference))
}

/** One step of the attack/release follower used to smooth a band. */
function envelopeStep(value: number, previous: number, attack: number, release: number): number {
  const coefficient = value > previous ? attack : release
  return previous + (value - previous) * coefficient
}

/** Normalise one raw band and advance its attack/release follower. */
function stepBand(
  raw: number,
  reference: number,
  gain: number,
  previous: number,
  attack: number,
  release: number,
): number {
  return envelopeStep(normaliseEnergy(raw, reference, gain), previous, attack, release)
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/** Scale by the reference loudness, compress the dynamics and smooth. */
function smoothEnvelope(
  raw: Float32Array,
  reference: number,
  gain: number,
  attack: number,
  release: number,
): Float32Array {
  const out = new Float32Array(raw.length)
  if (!(reference > 1e-8)) return out
  let previous = 0
  for (let index = 0; index < raw.length; index += 1) {
    previous = stepBand(raw[index], reference, gain, previous, attack, release)
    out[index] = clamp01(previous)
  }
  return out
}

/**
 * Streaming clap detector: a sharp rise in the clap band that stands clearly
 * above the recent average fires an onset, each onset starts a short decay
 * envelope and increments the palette counter. Shared by the batch analysis
 * and the live (microphone) analyzer.
 */
class ClapDetector {
  private envelope = 0
  private count = 0
  private lastOnset = Number.NEGATIVE_INFINITY
  private average = 0

  /** Number of onsets seen so far. */
  get clapCount(): number {
    return this.count
  }

  reset(): void {
    this.envelope = 0
    this.count = 0
    this.lastOnset = Number.NEGATIVE_INFINITY
    this.average = 0
  }

  /** Advance one frame and return the clap envelope for it. */
  step(value: number, index: number, minimumGap: number): number {
    const onset = value > 0.22 && value > this.average * 1.6 && index - this.lastOnset >= minimumGap
    if (onset) {
      this.count += 1
      this.lastOnset = index
      this.envelope = Math.max(this.envelope, Math.min(1, 0.35 + value * 0.65))
    } else {
      this.envelope *= 0.8
      if (this.envelope < 0.004) this.envelope = 0
    }
    // Follow the band slowly so a steady hi-hat does not fire on every frame.
    this.average += (value - this.average) * 0.12
    return this.envelope
  }
}

/**
 * Find hand-clap style transients: a sharp rise in the 1.8–5.8 kHz band that
 * stands clearly above the recent average. Each onset produces a short decay
 * envelope and increments the palette counter.
 */
function detectClaps(
  raw: Float32Array,
  reference: number,
  hopSeconds: number,
  gain: number,
): { clap: Float32Array; clapCount: Uint32Array } {
  const clap = new Float32Array(raw.length)
  const clapCount = new Uint32Array(raw.length)

  if (!(reference > 1e-8)) return { clap, clapCount }

  // A clap cannot retrigger faster than ~85 ms (four frames).
  const minimumGap = Math.max(2, Math.round(0.085 / hopSeconds))
  const detector = new ClapDetector()

  for (let index = 0; index < raw.length; index += 1) {
    const value = normaliseEnergy(raw[index], reference, gain)
    clap[index] = detector.step(value, index, minimumGap)
    clapCount[index] = detector.clapCount
  }
  return { clap, clapCount }
}

/**
 * Loudness reference used to normalise a band.
 *
 * The 95th percentile is a robust "loud moment": quiet tracks still react and a
 * single clipped transient does not flatten the whole curve. Tracks where the
 * band is silent most of the time (sparse claps) have a zero percentile, so the
 * maximum is used as a fallback.
 */
function referenceLevel(values: Float32Array): number {
  if (values.length === 0) return 0
  let maximum = 0
  for (const value of values) if (value > maximum) maximum = value
  if (!(maximum > 1e-8)) return 0
  return Math.max(percentile(values, 0.95), maximum * 0.35)
}

/** Value at a percentile of the array (0…1). Sorts a copy. */
function percentile(values: Float32Array, fraction: number): number {
  if (values.length === 0) return 0
  const sorted = Float32Array.from(values).sort()
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction)))
  return sorted[index]
}

function hannWindow(size: number): Float32Array {
  const window = new Float32Array(size)
  for (let index = 0; index < size; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / Math.max(1, size - 1))
  }
  return window
}

function mix(values: Float32Array, first: number, second: number, blend: number): number {
  return values[first] + (values[second] - values[first]) * blend
}

/** Below this total energy the live reference stops decaying (silence guard). */
const LIVE_REFERENCE_FLOOR = 20
/** How fast the live reference follows a quieter input, per analysed frame. */
const LIVE_REFERENCE_RELEASE = 0.004

/**
 * Streaming band analysis for the microphone.
 *
 * Uses the same FFT, band definitions, normalisation and clap detection as
 * {@link analyzeMusic}, but there is no whole track to take a percentile of:
 * the reference is a peak follower. A louder moment becomes the reference
 * immediately and it decays slowly, which keeps the bands responsive without
 * pumping; a floor keeps near-silence from being amplified to full scale.
 */
export class LiveBandAnalyzer {
  private readonly fft = new FFT(LIVE_FFT_SIZE)
  private readonly window = hannWindow(LIVE_FFT_SIZE)
  private readonly real = new Float32Array(LIVE_FFT_SIZE)
  private readonly imaginary = new Float32Array(LIVE_FFT_SIZE)
  private readonly raw = createBandEnergies()
  private readonly smoothed = createBandEnergies()
  private readonly claps = new ClapDetector()
  private reference = 0
  private frame = 0

  /** Forget the previous stream: smoothing, clap count and reference level. */
  reset(): void {
    this.smoothed.bass = 0
    this.smoothed.low = 0
    this.smoothed.mid = 0
    this.smoothed.voice = 0
    this.claps.reset()
    this.reference = 0
    this.frame = 0
  }

  /**
   * Analyse one window of time-domain samples and write the bands into
   * `target`. Windows shorter than {@link LIVE_FFT_SIZE} are zero-padded in
   * front; longer ones use the most recent samples. The frame time is taken
   * from the window length, so a caller feeding successive, non-overlapping
   * windows gets the same ~21 ms hop the batch analysis uses.
   */
  process(samples: Float32Array, sampleRate: number, target: AudioLevels): AudioLevels {
    const rate = sampleRate > 0 ? sampleRate : ANALYSIS_RATE
    const size = LIVE_FFT_SIZE
    const count = Math.min(size, samples.length)
    const offset = size - count
    for (let index = 0; index < offset; index += 1) this.real[index] = 0
    for (let index = 0; index < count; index += 1) {
      this.real[offset + index] = samples[samples.length - count + index] * this.window[offset + index]
    }
    this.imaginary.fill(0)
    this.fft.transform(this.real, this.imaginary)
    measureBands(this.real, this.imaginary, rate / size, size / 2 - 1, this.raw)

    const total = combinedEnergy(this.raw.bass, this.raw.low, this.raw.mid, this.raw.voice, this.raw.clap)
    if (total > this.reference) this.reference = total
    else this.reference += (total - this.reference) * LIVE_REFERENCE_RELEASE
    const reference = Math.max(this.reference, LIVE_REFERENCE_FLOOR)

    const hopSeconds = Math.min(0.25, Math.max(1 / 240, samples.length / rate))
    const minimumGap = Math.max(2, Math.round(0.085 / hopSeconds))

    this.smoothed.bass = stepBand(this.raw.bass, reference, 1.05, this.smoothed.bass, 0.55, 0.12)
    this.smoothed.low = stepBand(this.raw.low, reference, 1.5, this.smoothed.low, 0.6, 0.16)
    this.smoothed.mid = stepBand(this.raw.mid, reference, 1.6, this.smoothed.mid, 0.6, 0.16)
    this.smoothed.voice = stepBand(this.raw.voice, reference, 1.45, this.smoothed.voice, 0.22, 0.07)

    target.bass = clamp01(this.smoothed.bass)
    target.low = clamp01(this.smoothed.low)
    target.mid = clamp01(this.smoothed.mid)
    target.voice = clamp01(this.smoothed.voice)
    target.clap = this.claps.step(normaliseEnergy(this.raw.clap, reference, 1.8), this.frame, minimumGap)
    target.clapCount = this.claps.clapCount
    this.frame += 1
    return target
  }
}

/** In-place iterative radix-2 FFT. Only the magnitudes are used. */
class FFT {
  private readonly size: number
  private readonly cos: Float32Array
  private readonly sin: Float32Array
  private readonly reverse: Uint16Array

  constructor(size: number) {
    this.size = size
    this.cos = new Float32Array(size / 2)
    this.sin = new Float32Array(size / 2)
    for (let index = 0; index < size / 2; index += 1) {
      this.cos[index] = Math.cos((2 * Math.PI * index) / size)
      this.sin[index] = Math.sin((2 * Math.PI * index) / size)
    }
    this.reverse = new Uint16Array(size)
    const bits = Math.round(Math.log2(size))
    for (let index = 0; index < size; index += 1) {
      let value = index
      let reversed = 0
      for (let bit = 0; bit < bits; bit += 1) {
        reversed = (reversed << 1) | (value & 1)
        value >>= 1
      }
      this.reverse[index] = reversed
    }
  }

  transform(real: Float32Array, imaginary: Float32Array): void {
    const size = this.size
    for (let index = 0; index < size; index += 1) {
      const target = this.reverse[index]
      if (target > index) {
        const realValue = real[index]
        real[index] = real[target]
        real[target] = realValue
        const imaginaryValue = imaginary[index]
        imaginary[index] = imaginary[target]
        imaginary[target] = imaginaryValue
      }
    }
    for (let length = 2; length <= size; length <<= 1) {
      const half = length >> 1
      const step = size / length
      for (let start = 0; start < size; start += length) {
        for (let offset = 0; offset < half; offset += 1) {
          const angle = offset * step
          const cosine = this.cos[angle]
          const sine = this.sin[angle]
          const a = start + offset
          const b = a + half
          const tr = real[b] * cosine + imaginary[b] * sine
          const ti = imaginary[b] * cosine - real[b] * sine
          real[b] = real[a] - tr
          imaginary[b] = imaginary[a] - ti
          real[a] += tr
          imaginary[a] += ti
        }
      }
    }
  }
}
