/**
 * Video export via `MediaRecorder` + `HTMLCanvasElement.captureStream`.
 *
 * Everything happens in the browser: the WebGL canvas is captured at a
 * configurable resolution and frame rate, encoded by the browser's own encoder
 * and handed back as a Blob for download. Formats are probed at runtime — only
 * codecs the browser can actually produce are offered, and the UI explains it
 * when recording is unavailable.
 */

export interface RecordingFormat {
  mimeType: string
  label: string
  extension: string
  supported: boolean
}

export interface RecordingOptions {
  width: number
  height: number
  fps: number
  /** Playback speed multiplier applied while recording. */
  speed: number
  mimeType: string
  /** Overrides the automatically derived bitrate (bits per second). */
  bitrate?: number
}

export interface RecordingResult {
  blob: Blob
  url: string
  mimeType: string
  extension: string
  frames: number
  /** Wall-clock seconds spent recording. */
  elapsed: number
  /** Simulated timeline seconds covered by the recording. */
  simulatedSeconds: number
  bytes: number
}

const CANDIDATE_FORMATS: Omit<RecordingFormat, 'supported'>[] = [
  { mimeType: 'video/webm;codecs=vp9', label: 'WebM (VP9)', extension: 'webm' },
  { mimeType: 'video/webm;codecs=vp8', label: 'WebM (VP8)', extension: 'webm' },
  { mimeType: 'video/webm', label: 'WebM', extension: 'webm' },
  { mimeType: 'video/mp4;codecs=avc1.42E01E', label: 'MP4 (H.264)', extension: 'mp4' },
  { mimeType: 'video/mp4', label: 'MP4', extension: 'mp4' },
]

export function isRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function'
  )
}

export function availableFormats(): RecordingFormat[] {
  if (typeof MediaRecorder === 'undefined') {
    return CANDIDATE_FORMATS.map((format) => ({ ...format, supported: false }))
  }
  return CANDIDATE_FORMATS.map((format) => ({
    ...format,
    supported: MediaRecorder.isTypeSupported?.(format.mimeType) ?? false,
  }))
}

/** Preferred format: VP9 → VP8 → any WebM → MP4. */
export function preferredFormat(): RecordingFormat | null {
  const formats = availableFormats()
  return formats.find((format) => format.supported) ?? null
}

/** Resolution presets offered in the settings panel. */
export const RESOLUTION_PRESETS: { label: string; width: number; height: number }[] = [
  { label: '1280 × 720 (720p)', width: 1280, height: 720 },
  { label: '1920 × 1080 (1080p)', width: 1920, height: 1080 },
  { label: '2560 × 1440 (1440p)', width: 2560, height: 1440 },
  { label: '1080 × 1080 (square)', width: 1080, height: 1080 },
  { label: '1080 × 1920 (vertical)', width: 1080, height: 1920 },
]

export interface RecordingProgress {
  active: boolean
  frames: number
  elapsed: number
  bytes: number
  /** Simulated seconds captured so far and the total timeline duration. */
  capturedSeconds: number
  totalSeconds: number
  percent: number
}

export class VideoRecorder {
  private canvas: HTMLCanvasElement
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private chunks: Blob[] = []
  private options: RecordingOptions | null = null
  private startedAt = 0
  private elapsed = 0
  private result: RecordingResult | null = null
  private error: string | null = null
  private stopping = false

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
  }

  get isActive(): boolean {
    return this.recorder !== null && this.recorder.state === 'recording'
  }

  get lastResult(): RecordingResult | null {
    return this.result
  }

  get lastError(): string | null {
    return this.error
  }

  /** Begin recording. Throws when the browser cannot record. */
  start(options: RecordingOptions): MediaStream {
    if (!isRecordingSupported()) {
      throw new Error('This browser cannot record canvas video (MediaRecorder or captureStream is unavailable).')
    }
    if (this.isActive) throw new Error('A recording is already in progress.')
    const format = availableFormats().find((entry) => entry.mimeType === options.mimeType && entry.supported)
    if (!format) {
      const fallback = preferredFormat()
      if (!fallback) throw new Error('No supported video format was found in this browser.')
      options = { ...options, mimeType: fallback.mimeType }
      this.options = options
    } else {
      this.options = options
    }

    const stream = this.canvas.captureStream(options.fps)
    this.stream = stream
    this.chunks = []
    this.result = null
    this.error = null
    this.stopping = false
    this.elapsed = 0
    this.startedAt = performance.now()

    const bitrate = options.bitrate ?? Math.round(Math.min(20e6, Math.max(1.5e6, options.width * options.height * options.fps * 0.12)))
    try {
      this.recorder = new MediaRecorder(stream, {
        mimeType: this.options.mimeType,
        videoBitsPerSecond: bitrate,
      })
    } catch (error) {
      this.error = `The browser refused the recording configuration: ${(error as Error).message}`
      this.cleanupStream()
      throw new Error(this.error)
    }

    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data)
    }
    this.recorder.onerror = (event) => {
      this.error = `Recording error: ${(event as unknown as { error?: Error }).error?.message ?? 'unknown'}`
    }
    // A short timeslice keeps memory flat and lets us report progress in bytes.
    this.recorder.start(1000)
    return stream
  }

  /** Stop and resolve with the finished video. */
  async stop(): Promise<RecordingResult | null> {
    if (!this.recorder) return null
    if (this.stopping) return this.result
    this.stopping = true
    this.elapsed = (performance.now() - this.startedAt) / 1000
    const recorder = this.recorder

    const finished = new Promise<void>((resolve) => {
      const done = () => resolve()
      if (recorder.state === 'inactive') {
        done()
        return
      }
      recorder.onstop = done
      try {
        recorder.requestData()
      } catch {
        /* requestData can throw when already stopped. */
      }
      recorder.stop()
    })
    await finished

    this.cleanupStream()
    const mimeType = this.options?.mimeType ?? 'video/webm'
    const extension = availableFormats().find((format) => format.mimeType === mimeType)?.extension ?? 'webm'
    const blob = new Blob(this.chunks, { type: mimeType })
    this.chunks = []
    this.recorder = null
    this.result = {
      blob,
      url: URL.createObjectURL(blob),
      mimeType,
      extension,
      frames: 0,
      elapsed: this.elapsed,
      simulatedSeconds: 0,
      bytes: blob.size,
    }
    void this.stream
    this.stream = null
    return this.result
  }

  /** Discard the current recording (used when cancelling). */
  async cancel(): Promise<void> {
    if (!this.recorder) return
    const recorder = this.recorder
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
      if (recorder.state === 'inactive') resolve()
    })
    try {
      recorder.stop()
    } catch {
      /* already stopped */
    }
    await stopped
    this.cleanupStream()
    this.chunks = []
    this.recorder = null
    this.stream = null
  }

  private cleanupStream(): void {
    if (!this.stream) return
    for (const track of this.stream.getTracks()) track.stop()
    this.stream = null
  }

  /** Fill in the numbers the engine knows about (frames, simulated time). */
  complete(result: RecordingResult, frames: number, simulatedSeconds: number): RecordingResult {
    result.frames = frames
    result.simulatedSeconds = simulatedSeconds
    return result
  }

  progress(frames: number, capturedSeconds: number, totalSeconds: number): RecordingProgress {
    const elapsed = this.isActive ? (performance.now() - this.startedAt) / 1000 : this.elapsed
    const bytes = this.chunks.reduce((sum, chunk) => sum + chunk.size, 0)
    const percent = totalSeconds > 0 ? Math.min(100, (capturedSeconds / totalSeconds) * 100) : 0
    return {
      active: this.isActive,
      frames,
      elapsed,
      bytes,
      capturedSeconds,
      totalSeconds,
      percent,
    }
  }
}

/** Trigger a browser download for a recording result. */
export function downloadRecording(result: RecordingResult, name: string): void {
  const link = document.createElement('a')
  link.href = result.url
  link.download = `${name}.${result.extension}`
  document.body.appendChild(link)
  link.click()
  link.remove()
}

export { formatBytes } from '../util/format'
