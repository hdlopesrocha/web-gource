/**
 * Background music: decoding, looping and the volume envelope shared by live
 * playback and the deterministic export.
 *
 * An uploaded MP3 is decoded once into planar float samples. Playback uses an
 * `HTMLAudioElement` with `loop = true`; the export renders the same samples
 * into PCM chunks. Both use {@link fadeGain}, so the fade-in at the start and
 * the fade-out at the end of the animation are identical in the app and in the
 * exported file.
 */

export interface MusicSource {
  /** Sample rate of the decoded buffer. */
  sampleRate: number
  /** 1 (mono) or 2 (stereo). */
  numberOfChannels: number
  /** Sample frames in one loop of the track. */
  length: number
  /** Planar channel data, one Float32Array per channel. */
  channels: Float32Array[]
  /** Duration of one loop in seconds. */
  duration: number
}

export interface MusicEnvelope {
  /** Output volume, 0…1. */
  volume: number
  /** Fade-in length in output (video) seconds. */
  fadeInSeconds: number
  /** Fade-out length in output (video) seconds. */
  fadeOutSeconds: number
}

/**
 * Volume multiplier at a point in the animation.
 *
 * `endTime` is the moment the animation ends; the fade-out always finishes
 * there, so the final seconds of the video fade to silence. A zero length
 * disables that fade.
 */
export function fadeGain(
  time: number,
  endTime: number,
  fadeInSeconds: number,
  fadeOutSeconds: number,
  volume = 1,
): number {
  const safeVolume = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 0))
  if (!Number.isFinite(time) || !Number.isFinite(endTime)) return 0
  const inGain = fadeInSeconds > 0 ? time / fadeInSeconds : 1
  const outGain = fadeOutSeconds > 0 ? (endTime - time) / fadeOutSeconds : 1
  const gain = Math.min(1, inGain, outGain)
  return Math.max(0, Math.min(1, gain)) * safeVolume
}

/** Turn a decoded `AudioBuffer` into the source shape used here. */
export function musicSourceFromBuffer(buffer: AudioBuffer): MusicSource {
  const sourceChannels = Math.max(1, buffer.numberOfChannels)
  let channels: Float32Array[]

  if (sourceChannels <= 2) {
    channels = []
    for (let channel = 0; channel < sourceChannels; channel += 1) {
      channels.push(buffer.getChannelData(channel))
    }
  } else {
    // Multi-channel input: fold everything to stereo so the encoder and the
    // muxers only ever see mono or stereo.
    const left = new Float32Array(buffer.length)
    const right = new Float32Array(buffer.length)
    for (let channel = 0; channel < sourceChannels; channel += 1) {
      const data = buffer.getChannelData(channel)
      const target = channel % 2 === 0 ? left : right
      for (let index = 0; index < buffer.length; index += 1) target[index] += data[index]
    }
    const divisor = Math.max(1, Math.ceil(sourceChannels / 2))
    for (let index = 0; index < buffer.length; index += 1) {
      left[index] /= divisor
      right[index] /= divisor
    }
    channels = [left, right]
  }

  return {
    sampleRate: buffer.sampleRate,
    numberOfChannels: channels.length,
    length: buffer.length,
    channels,
    duration: buffer.duration,
  }
}

/** Decode an MP3 (or any audio file the browser understands) into PCM. */
export async function decodeMusicFile(file: Blob): Promise<MusicSource> {
  const data = await file.arrayBuffer()

  if (typeof OfflineAudioContext !== 'undefined') {
    // A one-sample offline context is enough: decodeAudioData resamples to the
    // context's rate, and the exporter resamples again if necessary.
    const context = new OfflineAudioContext(2, 1, 48_000)
    const buffer = await context.decodeAudioData(data.slice(0))
    return musicSourceFromBuffer(buffer)
  }

  if (typeof AudioContext !== 'undefined') {
    const context = new AudioContext({ sampleRate: 48_000 })
    try {
      const buffer = await context.decodeAudioData(data.slice(0))
      return musicSourceFromBuffer(buffer)
    } finally {
      await context.close().catch(() => undefined)
    }
  }

  throw new Error('This browser cannot decode audio files (Web Audio is unavailable).')
}

/** Options for rendering a block of looped background music. */
export interface MusicRenderOptions extends MusicEnvelope {
  /** Output sample rate. */
  sampleRate: number
  /** Output channel count. */
  numberOfChannels: number
  /** Length of the output in seconds (may extend slightly past `endTime`). */
  duration: number
  /** Moment the animation ends, in output seconds. Defaults to `duration`. */
  endTime?: number
}

/**
 * Render `frameCount` samples starting at `outputFrame`, looping the source and
 * applying the fade envelope. The source may have a different sample rate; it
 * is sampled linearly and wraps seamlessly.
 */
export function renderMusicChunk(
  source: MusicSource,
  outputFrame: number,
  frameCount: number,
  options: MusicRenderOptions,
): Float32Array[] {
  const channels: Float32Array[] = []
  for (let channel = 0; channel < Math.max(1, options.numberOfChannels); channel += 1) {
    channels.push(new Float32Array(Math.max(0, frameCount)))
  }
  const sourceLength = source.length
  if (sourceLength <= 0 || source.channels.length === 0) return channels

  const step = source.sampleRate / Math.max(1, options.sampleRate)
  const endTime = options.endTime ?? options.duration
  for (let index = 0; index < frameCount; index += 1) {
    const outputSample = outputFrame + index
    const time = outputSample / options.sampleRate
    const gain = fadeGain(time, endTime, options.fadeInSeconds, options.fadeOutSeconds, options.volume)
    if (gain <= 0) continue

    const position = (outputSample * step) % sourceLength
    const first = Math.floor(position)
    const second = (first + 1) % sourceLength
    const fraction = position - first
    for (let channel = 0; channel < channels.length; channel += 1) {
      const sourceChannel =
        source.channels.length === 1 ? source.channels[0] : source.channels[Math.min(channel, source.channels.length - 1)]
      const sample = sourceChannel[first] * (1 - fraction) + sourceChannel[second] * fraction
      channels[channel][index] = sample * gain
    }
  }
  return channels
}

/** State the live player reads from the engine. */
export interface MusicClockState {
  /** Simulated playback position in seconds. */
  time: number
  /** Simulated timeline duration in seconds. */
  duration: number
  /** Playback speed (simulated seconds per wall-clock second). */
  speed: number
  playing: boolean
}

/**
 * Map an animation position in simulated seconds onto the looping track.
 *
 * The audio element plays at real time, while the simulation advances at
 * `speed` simulated seconds per real second (and the exported video is
 * compressed by the same factor). Dividing by the speed keeps seeking in the
 * timeline aligned with the soundtrack, including when the track loops.
 */
export function musicLoopTime(time: number, speed: number, loopDuration: number): number {
  if (!(loopDuration > 0)) return 0
  const safeSpeed = Number.isFinite(speed) && speed > 0.05 ? speed : 1
  const videoTime = Math.max(0, Number.isFinite(time) ? time : 0) / safeSpeed
  return videoTime % loopDuration
}

export interface MusicPlayerSettings extends MusicEnvelope {}

/**
 * Live background music.
 *
 * The audio element loops independently; the volume envelope is driven by the
 * animation clock at animation-frame rate, so a 2× playback speed still fades
 * over two real seconds (and therefore matches the exported video, where the
 * timeline is compressed by the same speed).
 */
export class BackgroundMusic {
  private element: HTMLAudioElement | null = null
  private settings: MusicPlayerSettings = { volume: 0.7, fadeInSeconds: 2, fadeOutSeconds: 2 }
  private clock: (() => MusicClockState | null) | null = null
  private active = false
  private loopHandle: number | null = null
  private lastTime = 0
  /** Decoded track length, used before the audio element knows its duration. */
  private trackDuration = 0
  private currentVolume = 0
  private playbackError: string | null = null
  private retryAt = 0
  /** Fallback for browsers that stop at the end despite `loop = true`. */
  private readonly handleEnded = (): void => {
    if (!this.active || !this.element) return
    try {
      this.element.currentTime = 0
      const promise = this.element.play()
      if (promise) void promise.catch(() => undefined)
    } catch {
      /* The next sync retries when playback is allowed again. */
    }
  }

  private context: AudioContext | null = null
  private sourceNode: MediaElementAudioSourceNode | null = null
  private gainNode: GainNode | null = null
  private captureDestination: MediaStreamAudioDestinationNode | null = null

  get error(): string | null {
    return this.playbackError
  }

  get isLoaded(): boolean {
    return this.element !== null
  }

  /** True while the element is actually playing (not paused or blocked). */
  get playing(): boolean {
    return this.active
  }

  /** Position inside the current loop, in seconds. */
  get position(): number {
    const time = this.element?.currentTime
    return typeof time === 'number' && Number.isFinite(time) && time > 0 ? time : 0
  }

  /**
   * Create the looping audio element for an object URL. `duration` is the
   * decoded track length, which lets a seek land in the right place even before
   * the element has loaded its metadata.
   */
  load(url: string, duration = 0): void {
    this.unload()
    if (typeof document === 'undefined') return
    const element = document.createElement('audio')
    element.src = url
    element.loop = true
    element.preload = 'auto'
    element.volume = 0
    element.addEventListener('ended', this.handleEnded)
    this.element = element
    this.trackDuration = Number.isFinite(duration) && duration > 0 ? duration : 0
    this.playbackError = null
    this.lastTime = 0
  }

  /** Stop playback and release the audio element and its Web Audio graph. */
  unload(): void {
    this.releaseCapture()
    this.active = false
    this.stopVolumeLoop()
    if (this.element) {
      this.element.removeEventListener('ended', this.handleEnded)
      this.element.pause()
      this.element.removeAttribute('src')
      this.element.load()
    }
    this.element = null
    this.trackDuration = 0
    this.gainNode = null
    this.sourceNode = null
    if (this.context) {
      void this.context.close().catch(() => undefined)
      this.context = null
    }
    this.currentVolume = 0
    this.playbackError = null
    this.retryAt = 0
  }

  setClock(clock: (() => MusicClockState | null) | null): void {
    this.clock = clock
    if (!clock) this.pause()
  }

  setSettings(settings: Partial<MusicPlayerSettings>): void {
    this.settings = { ...this.settings, ...settings }
    const state = this.clock?.()
    if (state) this.applyVolume(state)
  }

  /**
   * Reconcile the audio element with the animation clock. Called on HUD
   * updates, playback actions and after the track is loaded.
   *
   * `retry` clears a previous autoplay block (the user just pressed play, which
   * is a gesture the browser accepts).
   */
  sync(retry = false): void {
    if (retry) this.retryAt = 0
    const state = this.clock?.()
    if (!this.element || !state) {
      if (this.active) this.pause()
      return
    }

    this.syncPosition(state)

    if (state.playing) {
      if (!this.active && state.time < 0.5 && this.lastTime > 1) {
        // Playback restarted from the beginning: restart the track as well.
        this.element.currentTime = 0
      }
      if (!this.active && performance.now() >= this.retryAt) this.start()
      this.applyVolume(state)
      if (this.active) this.startVolumeLoop()
    } else if (this.active) {
      this.pause()
      if (state.duration > 0 && state.time >= state.duration - 0.05) this.element.currentTime = 0
    } else {
      this.applyVolume(state)
    }
    this.lastTime = state.time
  }

  /** Pause without forgetting the current audio position. */
  pause(): void {
    this.active = false
    this.stopVolumeLoop()
    this.element?.pause()
  }

  /** Discard a blocked play() promise and try again on the next sync. */
  retry(): void {
    this.retryAt = 0
    this.sync(true)
  }

  /**
   * Stream the music (with its current volume envelope) for a live recording.
   * Returns null when there is no track or Web Audio is unavailable.
   */
  async captureStream(): Promise<MediaStream | null> {
    const element = this.element
    if (!element) return null
    const constructor =
      typeof AudioContext !== 'undefined'
        ? AudioContext
        : (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!constructor) return null

    try {
      if (!this.context || !this.sourceNode || !this.gainNode) {
        const context = new constructor()
        const source = context.createMediaElementSource(element)
        const gain = context.createGain()
        gain.gain.value = this.currentVolume
        source.connect(gain)
        gain.connect(context.destination)
        this.context = context
        this.sourceNode = source
        this.gainNode = gain
        element.volume = 1
      }
      if (this.context.state === 'suspended') await this.context.resume()
      if (this.captureDestination) this.releaseCapture()
      const destination = this.context.createMediaStreamDestination()
      this.sourceNode.connect(destination)
      this.captureDestination = destination
      return destination.stream
    } catch {
      return null
    }
  }

  /** Stop only the recording tap; playback keeps going. */
  releaseCapture(): void {
    if (!this.captureDestination) return
    try {
      this.sourceNode?.disconnect(this.captureDestination)
    } catch {
      /* already disconnected */
    }
    for (const track of this.captureDestination.stream.getTracks()) track.stop()
    this.captureDestination = null
  }

  /** Re-seek only on a real jump, so normal playback is never nudged. */
  private syncPosition(state: MusicClockState): void {
    const element = this.element
    if (!element) return
    const duration = this.loopDuration()
    if (!(duration > 0)) return

    // Seeking to the end leaves the track ready to start again when Play is
    // pressed (matching the engine, which replays from the beginning).
    const atEnd = state.duration > 0 && state.time >= state.duration - 0.05
    const target = atEnd ? 0 : musicLoopTime(state.time, state.speed, duration)
    const difference = Math.abs(this.position - target) % duration
    if (Math.min(difference, duration - difference) <= 0.25) return
    try {
      element.currentTime = target
    } catch {
      /* Metadata has not arrived yet; the next sync retries. */
    }
  }

  private loopDuration(): number {
    const duration = this.element?.duration
    if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) return duration
    return this.trackDuration
  }

  private start(): void {
    const element = this.element
    if (!element) return
    this.active = true
    this.currentVolume = 0
    this.applyOutputVolume()
    try {
      const promise = element.play()
      if (promise) {
        void promise
          .then(() => {
            this.playbackError = null
          })
          .catch(() => {
            this.playbackError =
              'The browser blocked background music. Press Play to allow audio playback, then try again.'
            this.retryAt = performance.now() + 5_000
            this.pause()
          })
      }
    } catch {
      this.playbackError = 'The browser blocked background music. Press Play to allow audio playback.'
      this.retryAt = performance.now() + 5_000
      this.pause()
    }
    this.startVolumeLoop()
  }

  private applyVolume(state: MusicClockState): void {
    const speed = state.speed > 0.05 ? state.speed : 1
    const time = Math.max(0, state.time) / speed
    const endTime = Math.max(0, state.duration) / speed
    this.currentVolume = fadeGain(
      time,
      endTime,
      this.settings.fadeInSeconds,
      this.settings.fadeOutSeconds,
      this.settings.volume,
    )
    this.applyOutputVolume()
  }

  private applyOutputVolume(): void {
    if (this.gainNode) this.gainNode.gain.value = this.currentVolume
    else if (this.element) this.element.volume = this.currentVolume
  }

  private startVolumeLoop(): void {
    if (this.loopHandle !== null) return
    if (typeof requestAnimationFrame !== 'function') return
    const tick = (): void => {
      if (!this.active) {
        this.loopHandle = null
        return
      }
      const state = this.clock?.()
      if (state) this.applyVolume(state)
      this.loopHandle = requestAnimationFrame(tick)
    }
    this.loopHandle = requestAnimationFrame(tick)
  }

  private stopVolumeLoop(): void {
    if (this.loopHandle !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.loopHandle)
    }
    this.loopHandle = null
  }
}
