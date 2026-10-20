/**
 * Live microphone audio, an alternative to the uploaded track.
 *
 * The graph is built once per capture and never touches
 * `context.destination` — monitoring a live microphone would feed back into
 * the room:
 *
 *     MediaStreamAudioSourceNode → GainNode → AnalyserNode     (bands)
 *                                        └──→ MediaStreamAudioDestinationNode (recorder tap)
 *
 * The gain node carries the same fade envelope as the file player (written by
 * the controller every animation frame), so a live capture fades in and out
 * like an export does, and the analyser sees the faded signal.
 */

import { LIVE_FFT_SIZE, LiveBandAnalyzer, type AudioLevels } from './analysis'

/** Raw audio: the browser must not "improve" the signal we analyse. */
const MICROPHONE_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
}

export class MicrophoneSource {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private gainNode: GainNode | null = null
  private analyserNode: AnalyserNode | null = null
  private captureDestination: MediaStreamAudioDestinationNode | null = null
  private timeDomain = new Float32Array(LIVE_FFT_SIZE)
  private readonly analyzer = new LiveBandAnalyzer()
  private active = false

  /** True while a microphone stream is live. */
  get running(): boolean {
    return this.active && this.stream !== null
  }

  /**
   * Ask for microphone permission and start capturing. Throws when permission
   * is denied or the graph cannot be built; the granted stream is stopped
   * again in every failure path, so a failed attempt never leaves the
   * microphone indicator on.
   */
  async start(): Promise<void> {
    if (this.running) return
    const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      throw new Error('this browser does not expose microphone capture')
    }

    const stream = await mediaDevices.getUserMedia(MICROPHONE_CONSTRAINTS)
    try {
      const context = this.ensureContext()
      // Record the context and the stream first: whatever fails below, the
      // teardown can close the context and stop the granted tracks.
      this.context = context
      this.stream = stream
      const source = context.createMediaStreamSource(stream)
      this.sourceNode = source
      const gain = context.createGain()
      this.gainNode = gain
      const analyser = context.createAnalyser()
      this.analyserNode = analyser
      const destination = context.createMediaStreamDestination()
      this.captureDestination = destination
      gain.gain.value = 0
      analyser.fftSize = LIVE_FFT_SIZE
      analyser.smoothingTimeConstant = 0
      source.connect(gain)
      gain.connect(analyser)
      gain.connect(destination)

      this.timeDomain = new Float32Array(analyser.fftSize)
      // A fresh stream gets fresh bands and a fresh clap count.
      this.analyzer.reset()
      this.active = true

      if (context.state === 'suspended' && typeof context.resume === 'function') {
        await context.resume().catch(() => undefined)
      }
    } catch (error) {
      // The permission prompt was already accepted: do not leave the mic open.
      this.teardown()
      for (const track of stream.getTracks()) track.stop()
      throw error
    }
  }

  /**
   * Stop capturing: the tracks are ended (the recording indicator goes away)
   * and the audio graph is released. Calling it twice is harmless.
   */
  stop(): void {
    this.active = false
    this.teardown()
  }

  /** Alias for {@link stop}: the whole capture is released. */
  release(): void {
    this.stop()
  }

  /** Alias for {@link stop}: the whole capture is released. */
  dispose(): void {
    this.stop()
  }

  /** Write the fade envelope into the live gain node (clamped to 0…1). */
  setFade(gain: number): void {
    const safe = Number.isFinite(gain) ? Math.max(0, Math.min(1, gain)) : 0
    if (this.gainNode) this.gainNode.gain.value = safe
  }

  /**
   * The stream to hand to the live recorder, with the current fade applied.
   *
   * The recorder stops the audio track when the take ends; an exhausted
   * destination is replaced here on the next take, while the microphone itself
   * keeps running.
   */
  captureStream(): MediaStream | null {
    const context = this.context
    const gain = this.gainNode
    if (!this.running || !context || !gain) return null
    const track = this.captureDestination?.stream.getAudioTracks()[0]
    if (!this.captureDestination || !track || track.readyState === 'ended') {
      if (this.captureDestination) {
        try {
          // The old destination is fed by the gain node: cut it there.
          gain.disconnect(this.captureDestination)
        } catch {
          /* already disconnected */
        }
      }
      const destination = context.createMediaStreamDestination()
      gain.connect(destination)
      this.captureDestination = destination
    }
    return this.captureDestination.stream
  }

  /**
   * Analyse the most recent samples of the faded signal. Returns silent levels
   * when nothing is running, so a stale frame cannot keep the visuals moving.
   */
  readLevels(target: AudioLevels): AudioLevels {
    const analyser = this.analyserNode
    const context = this.context
    if (!this.running || !analyser || !context) {
      target.bass = 0
      target.low = 0
      target.mid = 0
      target.voice = 0
      target.clap = 0
      target.clapCount = 0
      return target
    }
    if (this.timeDomain.length !== analyser.fftSize) this.timeDomain = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(this.timeDomain)
    return this.analyzer.process(this.timeDomain, context.sampleRate, target)
  }

  private ensureContext(): AudioContext {
    if (this.context && this.context.state !== 'closed') return this.context
    const constructor =
      typeof AudioContext !== 'undefined'
        ? AudioContext
        : (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!constructor) throw new Error('Web Audio is unavailable in this browser')
    return new constructor()
  }

  /** Disconnect the graph, stop every track and close the context. */
  private teardown(): void {
    const context = this.context
    const stream = this.stream
    try {
      this.sourceNode?.disconnect()
    } catch {
      /* already disconnected */
    }
    try {
      this.gainNode?.disconnect()
    } catch {
      /* already disconnected */
    }
    try {
      this.analyserNode?.disconnect()
    } catch {
      /* already disconnected */
    }
    try {
      this.captureDestination?.disconnect()
    } catch {
      /* already disconnected */
    }
    if (this.captureDestination) {
      for (const track of this.captureDestination.stream.getTracks()) track.stop()
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
    }
    this.context = null
    this.stream = null
    this.sourceNode = null
    this.gainNode = null
    this.analyserNode = null
    this.captureDestination = null
    if (context && context.state !== 'closed') {
      // The graph is fully disconnected, so closing can finish in the background.
      void context.close().catch(() => undefined)
    }
  }
}
