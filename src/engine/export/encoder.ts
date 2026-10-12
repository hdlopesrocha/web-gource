/**
 * WebCodecs encoder back end.
 *
 * The browser's `VideoEncoder` is used directly: it picks a hardware encoder
 * when the platform has one (we ask for `prefer-hardware` first) and falls back
 * to a software encoder otherwise. Nothing here buffers frames — encoded chunks
 * are handed to the muxer as they arrive.
 *
 * The interface is deliberately narrow so the export loop can be tested without
 * WebCodecs (which does not exist in jsdom, and only in secure contexts in
 * browsers).
 */

export type ExportContainer = 'webm' | 'mp4'
export type ExportVideoCodec = 'vp9' | 'vp8' | 'av1' | 'h264'

export interface CodecChoice {
  container: ExportContainer
  codec: ExportVideoCodec
  /** WebCodecs codec string, e.g. `vp09.00.10.08`. */
  codecString: string
  label: string
  /** File extension for the download. */
  extension: string
  mimeType: string
  /** True when the encoder reports a hardware implementation. */
  hardwareAccelerated: boolean
}

/** A frame ready to be encoded: a `VideoFrame` in the browser, a stub in tests. */
export interface ExportFrame {
  readonly timestamp: number
  /** Frame duration in microseconds (`VideoFrame` reports `null` until set). */
  readonly duration?: number | null
  close(): void
}

export interface EncodedChunk {
  data: Uint8Array
  timestamp: number
  duration: number
  keyFrame: boolean
}

/** Decoder configuration delivered with the first encoded chunk (MP4 needs it). */
export interface EncoderMetadata {
  description?: Uint8Array
}

export interface VideoEncoderBackend {
  readonly choice: CodecChoice
  readonly queueSize: number
  /** Encode a frame. The backend consumes (closes) the frame. */
  encode(frame: ExportFrame, options: { keyFrame: boolean }): void
  /** Resolve when every queued frame has been encoded. */
  flush(): Promise<void>
  close(): void
  onChunk(listener: (chunk: EncodedChunk, metadata: EncoderMetadata) => void): void
  onError(listener: (error: Error) => void): void
}

/* ------------------------------------------------------------------ *
 * Codec candidates
 * ------------------------------------------------------------------ */

interface Candidate {
  container: ExportContainer
  codec: ExportVideoCodec
  codecString: string
  label: string
  extension: string
  mimeType: string
}

/**
 * Candidates in preference order per container.
 *
 * VP9 first (the default output), then VP8 as a widely supported fallback, AV1
 * last (better compression, slower to encode). For MP4, constrained-baseline AVC
 * levels are probed from high to low so any resolution is covered without
 * B-frames (which would need reordering-aware composition offsets).
 */
const CANDIDATES: Record<ExportContainer, Candidate[]> = {
  webm: [
    { container: 'webm', codec: 'vp9', codecString: 'vp09.00.10.08', label: 'WebM · VP9', extension: 'webm', mimeType: 'video/webm' },
    { container: 'webm', codec: 'vp8', codecString: 'vp8', label: 'WebM · VP8', extension: 'webm', mimeType: 'video/webm' },
    { container: 'webm', codec: 'av1', codecString: 'av01.0.04M.08', label: 'WebM · AV1', extension: 'webm', mimeType: 'video/webm' },
  ],
  mp4: [
    { container: 'mp4', codec: 'h264', codecString: 'avc1.420033', label: 'MP4 · H.264', extension: 'mp4', mimeType: 'video/mp4' },
    { container: 'mp4', codec: 'h264', codecString: 'avc1.420028', label: 'MP4 · H.264 (level 4.0)', extension: 'mp4', mimeType: 'video/mp4' },
    { container: 'mp4', codec: 'h264', codecString: 'avc1.42001f', label: 'MP4 · H.264 (level 3.1)', extension: 'mp4', mimeType: 'video/mp4' },
  ],
}

export function isWebCodecsSupported(): boolean {
  return typeof globalThis.VideoEncoder !== 'undefined' && typeof globalThis.VideoFrame !== 'undefined'
}

interface DiscoveredCodec extends CodecChoice {
  candidate: Candidate
}

/**
 * Probe the encoders this browser actually has.
 *
 * Both output containers are probed because WebCodecs support differs by
 * platform. Only configuring happens here; the first real frame is what proves
 * a configuration works.
 */
export async function discoverCodecs(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<DiscoveredCodec[]> {
  if (!isWebCodecsSupported()) return []
  const found: DiscoveredCodec[] = []
  for (const container of ['webm', 'mp4'] as ExportContainer[]) {
    for (const candidate of CANDIDATES[container]) {
      const support = await probeConfig(candidate, width, height, fps, bitrate)
      if (!support) continue
      found.push({ ...candidate, candidate, hardwareAccelerated: support.hardwareAccelerated })
      break // First supported candidate per container is what we offer.
    }
  }
  return found
}

async function probeConfig(
  candidate: Candidate,
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<{ hardwareAccelerated: boolean } | null> {
  for (const acceleration of ['prefer-hardware', 'no-preference', 'prefer-software'] as HardwareAcceleration[]) {
    try {
      const config: VideoEncoderConfig = {
        codec: candidate.codecString,
        width,
        height,
        framerate: fps,
        bitrate,
        latencyMode: 'quality',
        hardwareAcceleration: acceleration,
      }
      const support = await globalThis.VideoEncoder.isConfigSupported(config)
      if (support.supported) return { hardwareAccelerated: acceleration === 'prefer-hardware' }
    } catch {
      /* try the next acceleration preference */
    }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * WebCodecs back end
 * ------------------------------------------------------------------ */

export interface BackendOptions {
  choice: CodecChoice
  width: number
  height: number
  fps: number
  bitrate: number
}

export class WebCodecsBackend implements VideoEncoderBackend {
  readonly choice: CodecChoice
  private encoder: VideoEncoder
  private chunkListeners: ((chunk: EncodedChunk, metadata: EncoderMetadata) => void)[] = []
  private errorListeners: ((error: Error) => void)[] = []
  private failed: Error | null = null

  private constructor(encoder: VideoEncoder, choice: CodecChoice) {
    this.encoder = encoder
    this.choice = choice
  }

  static async create(options: BackendOptions): Promise<WebCodecsBackend> {
    if (!isWebCodecsSupported()) {
      throw new Error('VideoEncoder is unavailable: exporting needs WebCodecs (Chrome/Edge 94+, Safari 16.4+).')
    }
    const preferences: HardwareAcceleration[] = options.choice.hardwareAccelerated
      ? ['prefer-hardware', 'no-preference', 'prefer-software']
      : ['no-preference', 'prefer-software']
    let lastError: Error | null = null

    for (const acceleration of preferences) {
      const config: VideoEncoderConfig = {
        codec: options.choice.codecString,
        width: options.width,
        height: options.height,
        framerate: options.fps,
        bitrate: options.bitrate,
        latencyMode: 'quality',
        hardwareAcceleration: acceleration,
      }
      try {
        const support = await VideoEncoder.isConfigSupported(config)
        if (!support.supported) {
          lastError = new Error('unsupported configuration')
          continue
        }
        let backend: WebCodecsBackend | null = null
        const encoder = new VideoEncoder({
          output: (chunk, metadata) => backend?.emit(chunk, metadata),
          error: (error) => backend?.fail(error),
        })
        backend = new WebCodecsBackend(encoder, {
          ...options.choice,
          hardwareAccelerated: acceleration === 'prefer-hardware',
        })
        encoder.configure(config)
        return backend
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
      }
    }
    throw new Error(`The browser refused the ${options.choice.label} encoder: ${lastError?.message ?? 'unknown error'}`)
  }

  private emit(chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata): void {
    if (this.failed) return
    const data = new Uint8Array(chunk.byteLength)
    chunk.copyTo(data)
    const encoded: EncodedChunk = {
      data,
      timestamp: chunk.timestamp,
      duration: chunk.duration ?? 0,
      keyFrame: chunk.type === 'key',
    }
    const info: EncoderMetadata = {}
    const description = metadata?.decoderConfig?.description
    if (description) info.description = copyBytes(description)
    for (const listener of this.chunkListeners) listener(encoded, info)
  }

  private fail(error: Error): void {
    if (this.failed) return
    this.failed = error instanceof Error ? error : new Error(String(error))
    for (const listener of this.errorListeners) listener(this.failed)
  }

  get queueSize(): number {
    return this.encoder.encodeQueueSize
  }

  encode(frame: ExportFrame, options: { keyFrame: boolean }): void {
    if (this.failed) {
      frame.close()
      return
    }
    try {
      this.encoder.encode(frame as unknown as VideoFrame, { keyFrame: options.keyFrame })
    } finally {
      // `encode` copies the frame synchronously, so it can be released at once.
      frame.close()
    }
  }

  async flush(): Promise<void> {
    if (this.failed) throw this.failed
    await this.encoder.flush()
    if (this.failed) throw this.failed
  }

  close(): void {
    try {
      if (this.encoder.state !== 'closed') this.encoder.close()
    } catch {
      /* already closed */
    }
    this.chunkListeners = []
    this.errorListeners = []
  }

  onChunk(listener: (chunk: EncodedChunk, metadata: EncoderMetadata) => void): void {
    this.chunkListeners.push(listener)
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener)
  }
}

/** Copy any buffer source (ArrayBuffer, SharedArrayBuffer or a view) into bytes. */
function copyBytes(source: ArrayBuffer | ArrayBufferView | SharedArrayBuffer): Uint8Array {
  if (ArrayBuffer.isView(source)) {
    const view = source as ArrayBufferView
    return new Uint8Array(new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength))
  }
  return new Uint8Array(new Uint8Array(source as ArrayBuffer))
}

/** Bitrate heuristic: resolution and frame rate, clamped to sane limits. */
export function defaultBitrate(width: number, height: number, fps: number): number {
  const raw = width * height * fps * 0.12
  return Math.round(Math.min(24e6, Math.max(2e6, raw)))
}
