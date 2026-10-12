import { describe, expect, it } from 'vitest'
import {
  durationForFrame,
  framePercent,
  isKeyFrame,
  keyFrameInterval,
  planFrames,
  timeForFrame,
  timestampForFrame,
  EXPORT_FPS,
} from '../src/engine/export/frames'
import { ExportCancelledError, OfflineExporter, type ExportFrameRequest } from '../src/engine/export/exporter'
import type { CodecChoice, EncodedChunk, EncoderMetadata, ExportFrame, VideoEncoderBackend } from '../src/engine/export/encoder'

/**
 * Export loop tests.
 *
 * The encoder is injected, so the deterministic part — which frames are
 * rendered, when, how they are keyframed, and how progress is reported — can be
 * checked without WebCodecs. The muxers are covered separately; here the
 * backend records what it was asked to encode.
 */

const choice: CodecChoice = {
  container: 'webm',
  codec: 'vp9',
  codecString: 'vp09.00.10.08',
  label: 'WebM · VP9',
  extension: 'webm',
  mimeType: 'video/webm',
  hardwareAccelerated: false,
}

const mp4Choice: CodecChoice = { ...choice, container: 'mp4', codec: 'h264', codecString: 'avc1.420028', label: 'MP4 · H.264', extension: 'mp4', mimeType: 'video/mp4' }

interface StubFrame {
  timestamp: number
  duration: number
  closed: boolean
  close(): void
}

class StubBackend implements VideoEncoderBackend {
  readonly choice: CodecChoice
  readonly encoded: { timestamp: number; keyFrame: boolean }[] = []
  readonly queueSamples: number[] = []
  framesClosed = 0
  framesCreated = 0
  flushed = false
  closed = false
  private chunks: ((chunk: EncodedChunk, metadata: EncoderMetadata) => void)[] = []
  private errors: ((error: Error) => void)[] = []
  private depth = 0
  failAfter: number | null = null
  /** Emit chunk metadata (MP4 needs the avcC description). */
  metadata: EncoderMetadata = {}

  constructor(choiceValue: CodecChoice = choice) {
    this.choice = choiceValue
  }

  get queueSize(): number {
    return this.depth
  }

  createFrame(timestamp: number, duration: number): StubFrame {
    this.framesCreated += 1
    const backend = this
    const frame: StubFrame = {
      timestamp,
      duration,
      closed: false,
      close() {
        if (this.closed) throw new Error('frame closed twice')
        this.closed = true
        backend.framesClosed += 1
      },
    }
    return frame
  }

  encode(frame: ExportFrame, options: { keyFrame: boolean }): void {
    this.encoded.push({ timestamp: frame.timestamp, keyFrame: options.keyFrame })
    this.queueSamples.push(this.depth)
    frame.close()
    if (this.failAfter !== null && this.encoded.length > this.failAfter) {
      for (const listener of this.errors) listener(new Error('encoder exploded'))
      return
    }
    // Emit one encoded chunk per frame, in order.
    const index = this.encoded.length - 1
    const chunk: EncodedChunk = {
      data: new Uint8Array([index & 0xff, 1, 2, 3]),
      timestamp: frame.timestamp,
      duration: frame.duration ?? 0,
      keyFrame: options.keyFrame,
    }
    for (const listener of this.chunks) listener(chunk, this.metadata)
  }

  async flush(): Promise<void> {
    this.flushed = true
  }

  close(): void {
    this.closed = true
  }

  onChunk(listener: (chunk: EncodedChunk, metadata: EncoderMetadata) => void): void {
    this.chunks.push(listener)
  }

  onError(listener: (error: Error) => void): void {
    this.errors.push(listener)
  }
}

function runExport(options: {
  duration: number
  choice?: CodecChoice
  backend?: StubBackend
  fps?: number
  onProgress?: Parameters<typeof OfflineExporter.prototype.run>[0]['onProgress']
}) {
  const backend = options.backend ?? new StubBackend(options.choice ?? choice)
  const exporter = new OfflineExporter()
  const requests: ExportFrameRequest[] = []
  const promise = exporter.run({
    duration: options.duration,
    choice: options.choice ?? choice,
    width: 640,
    height: 360,
    fps: options.fps,
    onProgress: options.onProgress,
    backendFactory: async () => backend,
    frameFactory: (request) => {
      requests.push(request)
      return backend.createFrame(request.timestamp, request.duration)
    },
  })
  return { exporter, backend, requests, promise }
}

describe('planFrames', () => {
  it('renders exactly 30 frames per simulated second, end inclusive', () => {
    expect(EXPORT_FPS).toBe(30)
    expect(planFrames(4).totalFrames).toBe(121)
    expect(planFrames(2).totalFrames).toBe(61)
    expect(planFrames(1).totalFrames).toBe(31)
    expect(planFrames(1 / 30).totalFrames).toBe(2)
    expect(planFrames(0).totalFrames).toBe(1)
    expect(planFrames(Number.NaN).totalFrames).toBe(1)
  })

  it('maps frame indices to simulated time without drift', () => {
    const plan = planFrames(4)
    expect(timeForFrame(plan, 0)).toBe(0)
    expect(timeForFrame(plan, 30)).toBeCloseTo(1, 10)
    expect(timeForFrame(plan, 60)).toBeCloseTo(2, 10)
    expect(timeForFrame(plan, 120)).toBeCloseTo(4, 10)
    // The last frame lands exactly on the end and never past it.
    expect(timeForFrame(plan, 999)).toBe(4)
  })

  it('keeps timestamps and durations exact over a long export', () => {
    const plan = planFrames(600)
    let total = 0
    for (let frame = 0; frame < plan.totalFrames; frame += 1) total += durationForFrame(plan, frame)
    expect(plan.totalFrames).toBe(18001)
    // Ten simulated minutes: 18001 frames cover [0, 600 s] plus the final frame,
    // so the total is one frame longer and drifts by less than a microsecond per
    // frame (each timestamp is derived from the frame index, never accumulated).
    const finalFrameDuration = durationForFrame(plan, plan.totalFrames - 1)
    expect(Math.abs(total - (600_000_000 + finalFrameDuration))).toBeLessThan(plan.totalFrames)
    expect(timestampForFrame(plan, 30)).toBe(1_000_000)
    expect(timestampForFrame(plan, 18_000)).toBe(600_000_000)
  })

  it('keyframes once per simulated second and reports progress', () => {
    const plan = planFrames(3)
    expect(keyFrameInterval(plan)).toBe(30)
    expect(isKeyFrame(plan, 0)).toBe(true)
    expect(isKeyFrame(plan, 30)).toBe(true)
    expect(isKeyFrame(plan, 31)).toBe(false)
    expect(framePercent(plan, 0)).toBe(0)
    expect(framePercent(plan, plan.totalFrames)).toBe(100)
    expect(framePercent(plan, plan.totalFrames / 2)).toBeCloseTo(50, 5)
  })
})

describe('OfflineExporter', () => {
  it('renders one frame per step from t = 0 to the end', async () => {
    const { backend, requests, promise } = runExport({ duration: 2 })
    const result = await promise
    expect(requests).toHaveLength(61)
    expect(backend.encoded).toHaveLength(61)
    expect(requests[0].simTime).toBe(0)
    expect(requests[30].simTime).toBeCloseTo(1, 10)
    expect(requests[60].simTime).toBeCloseTo(2, 10)
    // Timestamps advance by exactly one frame step.
    for (let index = 1; index < requests.length; index += 1) {
      expect(requests[index].timestamp - requests[index - 1].timestamp).toBeGreaterThanOrEqual(33333)
      expect(requests[index].timestamp - requests[index - 1].timestamp).toBeLessThanOrEqual(33334)
    }
    expect(result.frames).toBe(61)
    expect(result.seconds).toBe(2)
    expect(result.blob.type).toBe('video/webm')
    expect(result.extension).toBe('webm')
    expect(backend.flushed).toBe(true)
    expect(backend.closed).toBe(true)
  })

  it('keyframes once per second and closes every frame', async () => {
    const { backend, promise } = runExport({ duration: 3 })
    await promise
    const keyFrames = backend.encoded.filter((entry) => entry.keyFrame)
    expect(keyFrames.map((entry) => entry.timestamp)).toEqual([0, 1_000_000, 2_000_000, 3_000_000])
    // Frames are released as they are encoded: none stay alive.
    expect(backend.framesCreated).toBe(backend.framesClosed)
    expect(backend.framesCreated).toBe(91)
  })

  it('never keeps more than a few frames in the encoder queue', async () => {
    const { backend, promise } = runExport({ duration: 1 })
    await promise
    // The stub drains instantly, so the loop should never queue deeply.
    expect(Math.max(...backend.queueSamples)).toBeLessThanOrEqual(1)
  })

  it('reports progress with frames and simulated time, ending at 100%', async () => {
    const seen: { frames: number; simTime: number; percent: number; active: boolean }[] = []
    const { promise } = runExport({
      duration: 2,
      onProgress: (progress) => seen.push({ frames: progress.frames, simTime: progress.simTime, percent: progress.percent, active: progress.active }),
    })
    await promise
    expect(seen.length).toBeGreaterThan(3)
    expect(seen[0].active).toBe(true)
    const last = seen[seen.length - 1]
    expect(last.percent).toBe(100)
    expect(last.active).toBe(false)
    expect(last.frames).toBe(61)
    expect(last.simTime).toBe(2)
    // Progress is monotonic in frames.
    for (let index = 1; index < seen.length; index += 1) {
      expect(seen[index].frames).toBeGreaterThanOrEqual(seen[index - 1].frames)
    }
    // Intermediate reports carry a simulated time inside the animation.
    const middle = seen[Math.floor(seen.length / 2)]
    expect(middle.simTime).toBeGreaterThanOrEqual(0)
    expect(middle.simTime).toBeLessThanOrEqual(2)
  })

  it('cancels cleanly and closes the encoder', async () => {
    const { exporter, backend, promise } = runExport({ duration: 600 })
    // Cancel on the first progress report, i.e. while the loop is running.
    const original = backend.encode.bind(backend)
    let frames = 0
    backend.encode = (frame, options) => {
      original(frame, options)
      frames += 1
      if (frames === 3) exporter.cancel()
    }
    await expect(promise).rejects.toBeInstanceOf(ExportCancelledError)
    expect(backend.closed).toBe(true)
    expect(backend.framesCreated).toBe(backend.framesClosed)
  })

  it('propagates encoder errors', async () => {
    const backend = new StubBackend()
    backend.failAfter = 2
    const { promise } = runExport({ duration: 2, backend })
    await expect(promise).rejects.toThrow('encoder exploded')
    expect(backend.closed).toBe(true)
  })

  it('writes MP4 once the encoder provides the avcC description', async () => {
    const backend = new StubBackend(mp4Choice)
    backend.metadata = { description: new Uint8Array([1, 0x42, 0xc0, 0x28, 0xff, 0xe1, 0, 2, 1, 2, 1, 0, 2, 3, 4]) }
    const { promise } = runExport({ duration: 1, choice: mp4Choice, backend })
    const result = await promise
    expect(result.extension).toBe('mp4')
    expect(result.blob.type).toBe('video/mp4')
    expect(result.bytes).toBeGreaterThan(200)
  })

  it('refuses to run twice at the same time', async () => {
    const exporter = new OfflineExporter()
    const backend = new StubBackend()
    const first = exporter.run({
      duration: 1,
      choice,
      width: 320,
      height: 240,
      backendFactory: async () => backend,
      frameFactory: (request) => backend.createFrame(request.timestamp, request.duration),
    })
    await expect(
      exporter.run({
        duration: 1,
        choice,
        width: 320,
        height: 240,
        backendFactory: async () => new StubBackend(),
        frameFactory: (request) => new StubBackend().createFrame(request.timestamp, request.duration),
      }),
    ).rejects.toThrow(/already running/)
    await first
  })
})
