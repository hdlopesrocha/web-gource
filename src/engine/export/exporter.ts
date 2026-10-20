/**
 * Deterministic offline export.
 *
 * Plays the animation from simulated time `t = 0` to the end of the timeline at
 * exactly {@link EXPORT_FPS} frames per simulated second, encodes every frame
 * with WebCodecs and muxes the result into WebM (default) or MP4. The loop is
 * driven by the frame index, never by the wall clock, so a slow machine produces
 * the same video as a fast one — it just takes longer.
 *
 * Frames are never accumulated: each frame is rendered, encoded and released
 * before the next one starts, and the encoder queue is kept bounded. Only the
 * compressed stream (plus a small header) is retained, so memory stays flat for
 * long exports.
 */

import { EXPORT_FPS, durationForFrame, framePercent, isKeyFrame, planFrames, timeForFrame, timestampForFrame, type FramePlan } from './frames'
import { Mp4Muxer } from './mp4'
import { WebmMuxer, type WebmCodec } from './webm'
import { defaultBitrate, WebCodecsBackend, type CodecChoice, type ExportFrame, type VideoEncoderBackend } from './encoder'
import {
  EXPORT_AUDIO_SAMPLE_RATE,
  MusicEncodingCancelledError,
  OPUS_PRE_SKIP,
  OPUS_SEEK_PRE_ROLL_NS,
  encodeMusicTrack,
  type EncodedMusicTrack,
} from './audio'
import type { MusicEnvelope, MusicSource } from '../audio/music'

export type { ExportFrame }

/** Encoder queue depth to stay under; above this the loop yields to the encoder. */
const MAX_QUEUE_DEPTH = 8

export interface ExportFrameRequest {
  /** Simulated time this frame represents. */
  simTime: number
  /** Frame index, 0-based. */
  frame: number
  /** Presentation timestamp in microseconds. */
  timestamp: number
  /** Frame duration in microseconds. */
  duration: number
}

export type ExportFrameFactory = (request: ExportFrameRequest) => ExportFrame

export interface ExportProgress {
  active: boolean
  /** Frames encoded so far, and the total for this animation. */
  frames: number
  totalFrames: number
  /** Simulated time reached, and the animation's duration, in seconds. */
  simTime: number
  duration: number
  percent: number
  /** Bytes written to the container so far (compressed). */
  bytes: number
  fps: number
  /** Frames waiting in the encoder queue. */
  queue: number
}

export interface ExportResult {
  blob: Blob
  mimeType: string
  extension: string
  /** Frames encoded (equal to the plan's frame count). */
  frames: number
  /** Simulated seconds covered. */
  seconds: number
  /** Playback speed the export followed. */
  speed: number
  bytes: number
  /** Wall-clock seconds the export took. */
  elapsed: number
  choice: CodecChoice
  bitrate: number
  /** True when the background music track is part of the file. */
  audio: boolean
}

/** Music source and envelope for the export. */
export interface ExportMusicOptions extends MusicEnvelope {
  source: MusicSource
}

export interface OfflineExportOptions {
  /** Animation length in simulated seconds (the simulation's end condition). */
  duration: number
  choice: CodecChoice
  /** Renderer resolution, preserved frame for frame. */
  width: number
  height: number
  frameFactory: ExportFrameFactory
  /** Overrides the derived bitrate. */
  bitrate?: number
  fps?: number
  /** Playback speed to follow (the speed selected in the app). */
  speed?: number
  /** Background music, looped and faded over the video's duration. */
  audio?: ExportMusicOptions
  onProgress?: (progress: ExportProgress) => void
  /** Injection point for tests; defaults to the WebCodecs backend. */
  backendFactory?: (plan: FramePlan, bitrate: number) => Promise<VideoEncoderBackend>
}

export class ExportCancelledError extends Error {
  constructor() {
    super('The export was cancelled.')
    this.name = 'ExportCancelledError'
  }
}

export class OfflineExporter {
  private cancelled = false
  private running = false
  private backend: VideoEncoderBackend | null = null

  get isRunning(): boolean {
    return this.running
  }

  /** Request cancellation; the running export rejects with ExportCancelledError. */
  cancel(): void {
    this.cancelled = true
  }

  /**
   * Render and encode the whole animation.
   *
   * Resolves with the finished video once every frame has been encoded, the
   * encoder has been flushed and the container has been finalised.
   */
  async run(options: OfflineExportOptions): Promise<ExportResult> {
    if (this.running) throw new Error('An export is already running.')
    this.running = true
    this.cancelled = false
    const startedAt = Date.now()

    const plan = planFrames(options.duration, options.fps ?? EXPORT_FPS, options.speed ?? 1)
    const bitrate = options.bitrate ?? defaultBitrate(options.width, options.height, plan.fps)
    let encodedFrames = 0
    let simTime = 0
    let progress = 0

    const report = (force = false): void => {
      if (!options.onProgress) return
      if (!force && encodedFrames - progress < 5) return
      progress = encodedFrames
      options.onProgress({
        active: true,
        frames: encodedFrames,
        totalFrames: plan.totalFrames,
        simTime,
        duration: plan.duration,
        percent: framePercent(plan, encodedFrames),
        bytes: muxerBytes(),
        fps: plan.fps,
        queue: this.backend?.queueSize ?? 0,
      })
    }

    let muxer: WebmMuxer | Mp4Muxer
    const muxerBytes = (): number => muxer?.bytesWritten ?? 0
    /** Chunks arrive in decode order, so the decode time is the output index. */
    let samplesOut = 0

    try {
      let encodedMusic: EncodedMusicTrack | null = null
      if (options.audio) {
        try {
          encodedMusic = await encodeMusicTrack({
            source: options.audio.source,
            container: options.choice.container,
            volume: options.audio.volume,
            fadeInSeconds: options.audio.fadeInSeconds,
            fadeOutSeconds: options.audio.fadeOutSeconds,
            // Include the final frame's duration, exactly like the video track.
            duration: plan.totalFrames / plan.fps,
            // The fade-out finishes on the last animation frame.
            endTime: plan.duration / plan.speed,
            shouldCancel: () => this.cancelled,
          })
        } catch (error) {
          if (this.cancelled || error instanceof MusicEncodingCancelledError) throw new ExportCancelledError()
          throw error
        }
        if (this.cancelled) throw new ExportCancelledError()
      }

      this.backend = await (options.backendFactory
        ? options.backendFactory(plan, bitrate)
        : WebCodecsBackend.create({
            choice: options.choice,
            width: options.width,
            height: options.height,
            fps: plan.fps,
            bitrate,
          }))

      muxer =
        options.choice.container === 'webm'
          ? new WebmMuxer()
          : new Mp4Muxer()
      let containerReady = false
      if (options.choice.container === 'webm') {
        ;(muxer as WebmMuxer).initialize(
          {
            width: options.width,
            height: options.height,
            codec: options.choice.codec as WebmCodec,
            frameDurationUs: Math.round(1_000_000 / plan.fps),
          },
          encodedMusic
            ? {
                codecPrivate: encodedMusic.description,
                sampleRate: encodedMusic.sampleRate,
                numberOfChannels: encodedMusic.numberOfChannels,
                codecDelayNs: Math.round((OPUS_PRE_SKIP / EXPORT_AUDIO_SAMPLE_RATE) * 1_000_000_000),
                seekPreRollNs: OPUS_SEEK_PRE_ROLL_NS,
                frameDurationUs: 20_000,
              }
            : undefined,
        )
        containerReady = true
      }

      /** Add encoded audio packets up to a video timestamp to keep the file interleaved. */
      let audioIndex = 0
      const addAudioUpTo = (timestamp: number): void => {
        if (!encodedMusic) return
        while (audioIndex < encodedMusic.chunks.length && encodedMusic.chunks[audioIndex].timestamp <= timestamp) {
          const packet = encodedMusic.chunks[audioIndex]
          audioIndex += 1
          if (options.choice.container === 'webm') {
            ;(muxer as WebmMuxer).addAudioFrame({ data: packet.data, timestamp: packet.timestamp, keyFrame: true })
          } else {
            ;(muxer as Mp4Muxer).addAudioFrame({
              data: packet.data,
              timestamp: packet.timestamp,
              duration: packet.duration,
            })
          }
        }
      }

      let encoderError: Error | null = null
      this.backend.onError((error) => {
        encoderError = error
      })
      this.backend.onChunk((chunk, metadata) => {
        if (encoderError) return
        if (!containerReady) {
          // MP4 needs the AVC decoder description, which arrives with the first
          // chunk's metadata.
          ;(muxer as Mp4Muxer).initialize({
            width: options.width,
            height: options.height,
            description: metadata.description ?? new Uint8Array(0),
            audio: encodedMusic
              ? {
                  sampleRate: encodedMusic.sampleRate,
                  numberOfChannels: encodedMusic.numberOfChannels,
                  description: encodedMusic.description,
                  bitrate: 128_000,
                }
              : undefined,
          })
          containerReady = true
        }
        if (options.choice.container === 'webm') {
          ;(muxer as WebmMuxer).addFrame({ data: chunk.data, timestamp: chunk.timestamp, keyFrame: chunk.keyFrame })
        } else {
          const decodeTime = timestampForFrame(plan, Math.min(plan.totalFrames - 1, samplesOut))
          samplesOut += 1
          ;(muxer as Mp4Muxer).addFrame({
            data: chunk.data,
            timestamp: chunk.timestamp,
            duration: chunk.duration > 0 ? chunk.duration : durationForFrame(plan, 0),
            keyFrame: chunk.keyFrame,
            decodeTime,
          })
        }
        addAudioUpTo(chunk.timestamp)
      })

      report(true)

      for (let frame = 0; frame < plan.totalFrames; frame += 1) {
        if (this.cancelled) throw new ExportCancelledError()
        if (encoderError) throw encoderError

        simTime = timeForFrame(plan, frame)
        const request: ExportFrameRequest = {
          simTime,
          frame,
          timestamp: timestampForFrame(plan, frame),
          duration: durationForFrame(plan, frame),
        }
        const source = options.frameFactory(request)
        this.backend.encode(source, { keyFrame: isKeyFrame(plan, frame) })
        encodedFrames += 1
        simTime = timeForFrame(plan, Math.min(plan.totalFrames - 1, frame + 1))
        report()

        // Backpressure: keep only a few frames in the encoder at a time so a
        // long export cannot balloon in memory.
        while (this.backend.queueSize > MAX_QUEUE_DEPTH) {
          await delay(1)
          if (this.cancelled) throw new ExportCancelledError()
          if (encoderError) throw encoderError
        }
      }

      await this.backend.flush()
      if (encoderError) throw encoderError
      // Add any audio packets after the last video timestamp (encoder padding).
      addAudioUpTo(Number.POSITIVE_INFINITY)

      const parts = muxer.finish()
      const blob = new Blob(parts as BlobPart[], { type: options.choice.mimeType })
      simTime = plan.duration
      encodedFrames = plan.totalFrames
      report(true)

      return {
        blob,
        mimeType: options.choice.mimeType,
        extension: options.choice.extension,
        frames: plan.totalFrames,
        seconds: plan.duration,
        speed: plan.speed,
        bytes: blob.size,
        elapsed: (Date.now() - startedAt) / 1000,
        choice: options.choice,
        bitrate,
        audio: encodedMusic !== null,
      }
    } finally {
      this.backend?.close()
      this.backend = null
      this.running = false
      options.onProgress?.({
        active: false,
        frames: encodedFrames,
        totalFrames: plan.totalFrames,
        simTime,
        duration: plan.duration,
        percent: this.cancelled ? framePercent(plan, encodedFrames) : 100,
        bytes: muxerBytes(),
        fps: plan.fps,
        queue: 0,
      })
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
