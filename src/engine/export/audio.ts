/**
 * Encode the background music into the audio track of the export.
 *
 * The decoded MP3 is looped and faded in memory, fed to the browser's
 * `AudioEncoder` (Opus for WebM, AAC for MP4) and returned as encoded chunks
 * plus the decoder description the muxers need. Nothing is buffered beyond the
 * compressed chunks, so a long animation does not keep raw PCM around.
 */

import type { MusicEnvelope, MusicSource } from '../audio/music'
import { renderMusicChunk } from '../audio/music'

/** Audio encoders run at 48 kHz; the source is resampled while rendering. */
export const EXPORT_AUDIO_SAMPLE_RATE = 48_000
/** 20 ms blocks: the usual Opus and AAC packet size. */
const AUDIO_CHUNK_FRAMES = 960
/** Encoder queue depth before the loop yields. */
const MAX_AUDIO_QUEUE = 16

export type MusicCodec = 'opus' | 'aac'

export interface EncodedMusicChunk {
  data: Uint8Array
  /** Presentation timestamp in microseconds. */
  timestamp: number
  /** Duration in microseconds. */
  duration: number
}

export interface EncodedMusicTrack {
  codec: MusicCodec
  /** WebCodecs codec string (`opus` / `mp4a.40.2`). */
  codecString: string
  sampleRate: number
  numberOfChannels: number
  /** OpusHead or AudioSpecificConfig, as required by the container. */
  description: Uint8Array
  chunks: EncodedMusicChunk[]
  bytes: number
}

export interface EncodeMusicOptions extends MusicEnvelope {
  source: MusicSource
  container: 'webm' | 'mp4'
  /** Length of the video in seconds. */
  duration: number
  /** Moment the animation ends, in video seconds. */
  endTime: number
  bitrate?: number
  /** Polled between chunks so cancelling an export also stops encoding. */
  shouldCancel?: () => boolean
}

export class MusicEncodingCancelledError extends Error {
  constructor() {
    super('Music encoding was cancelled.')
    this.name = 'MusicEncodingCancelledError'
  }
}

export function isMusicEncodingSupported(): boolean {
  return typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined'
}

/**
 * Encode the looped, faded music for the whole video.
 *
 * Throws when this browser has no audio encoder for the requested container;
 * the caller can then export a silent video or tell the user why audio is not
 * possible.
 */
export async function encodeMusicTrack(options: EncodeMusicOptions): Promise<EncodedMusicTrack> {
  if (!isMusicEncodingSupported()) {
    throw new Error(
      'This browser cannot encode audio (WebCodecs AudioEncoder is unavailable). Remove the background music to export a silent video.',
    )
  }

  const codec: MusicCodec = options.container === 'webm' ? 'opus' : 'aac'
  const codecString = codec === 'opus' ? 'opus' : 'mp4a.40.2'
  const sampleRate = EXPORT_AUDIO_SAMPLE_RATE
  const numberOfChannels = options.source.numberOfChannels === 1 ? 1 : 2
  const bitrate = options.bitrate ?? 128_000
  const config: AudioEncoderConfig = {
    codec: codecString,
    sampleRate,
    numberOfChannels,
    bitrate,
  }

  const support = await AudioEncoder.isConfigSupported(config).catch(() => null)
  if (!support?.supported) {
    const containerLabel = options.container === 'webm' ? 'WebM' : 'MP4'
    const codecLabel = codec === 'opus' ? 'Opus' : 'AAC'
    throw new Error(
      `This browser cannot encode ${codecLabel} audio for ${containerLabel} exports. Remove the background music to export a silent video, or try a different container.`,
    )
  }

  const chunks: EncodedMusicChunk[] = []
  let description: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  let failure: Error | null = null
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      chunks.push({
        data,
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? Math.round((AUDIO_CHUNK_FRAMES / sampleRate) * 1_000_000),
      })
      const metadataDescription = metadata?.decoderConfig?.description
      if (metadataDescription && description.length === 0) description = copyBytes(metadataDescription)
    },
    error: (error) => {
      failure = error instanceof Error ? error : new Error(String(error))
    },
  })

  try {
    encoder.configure(config)
    const totalFrames = Math.max(1, Math.round(options.duration * sampleRate))
    const renderOptions = {
      sampleRate,
      numberOfChannels,
      duration: options.duration,
      endTime: options.endTime,
      volume: options.volume,
      fadeInSeconds: options.fadeInSeconds,
      fadeOutSeconds: options.fadeOutSeconds,
    }

    for (let start = 0; start < totalFrames; start += AUDIO_CHUNK_FRAMES) {
      if (options.shouldCancel?.()) throw new MusicEncodingCancelledError()
      if (failure) throw failure
      const frameCount = Math.min(AUDIO_CHUNK_FRAMES, totalFrames - start)
      const planar = renderMusicChunk(options.source, start, frameCount, renderOptions)
      const packed = new Float32Array(frameCount * numberOfChannels)
      for (let channel = 0; channel < numberOfChannels; channel += 1) {
        packed.set(planar[channel] ?? new Float32Array(frameCount), channel * frameCount)
      }
      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: frameCount,
        numberOfChannels,
        timestamp: Math.round((start / sampleRate) * 1_000_000),
        data: packed.buffer,
      })
      encoder.encode(audioData)
      audioData.close()

      while (encoder.encodeQueueSize > MAX_AUDIO_QUEUE) {
        await delay(0)
        if (options.shouldCancel?.()) throw new MusicEncodingCancelledError()
        if (failure) throw failure
      }
    }

    await encoder.flush()
    if (failure) throw failure
  } finally {
    try {
      if (encoder.state !== 'closed') encoder.close()
    } catch {
      /* already closed */
    }
  }

  chunks.sort((a, b) => a.timestamp - b.timestamp)
  if (chunks.length > 0 && chunks[0].timestamp < 0) {
    const shift = -chunks[0].timestamp
    for (const chunk of chunks) chunk.timestamp += shift
  }
  if (description.length === 0) {
    description =
      codec === 'opus'
        ? buildOpusHead(numberOfChannels, sampleRate)
        : buildAudioSpecificConfig(sampleRate, numberOfChannels)
  }

  return {
    codec,
    codecString,
    sampleRate,
    numberOfChannels,
    description,
    chunks,
    bytes: chunks.reduce((sum, chunk) => sum + chunk.data.length, 0),
  }
}

/** Pre-skip for a libopus-style OpusHead (samples at 48 kHz). */
export const OPUS_PRE_SKIP = 312
/** Recommended Matroska seek pre-roll for Opus (80 ms in nanoseconds). */
export const OPUS_SEEK_PRE_ROLL_NS = 80_000_000

/** OpusHead used when the browser's encoder does not supply one. */
export function buildOpusHead(numberOfChannels: number, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(19)
  bytes.set(new TextEncoder().encode('OpusHead'), 0)
  bytes[8] = 1 // version
  bytes[9] = numberOfChannels
  const view = new DataView(bytes.buffer)
  view.setUint16(10, OPUS_PRE_SKIP, true)
  view.setUint32(12, sampleRate, true)
  view.setInt16(16, 0, true) // output gain
  bytes[18] = 0 // mapping family
  return bytes
}

const AAC_SAMPLE_RATES = [
  96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350,
]

/** Minimal AAC-LC AudioSpecificConfig used when the encoder omits it. */
export function buildAudioSpecificConfig(sampleRate: number, numberOfChannels: number): Uint8Array {
  const rateIndex = AAC_SAMPLE_RATES.indexOf(sampleRate)
  const frequencyIndex = rateIndex >= 0 ? rateIndex : 15
  // audioObjectType=2 (AAC LC), samplingFrequencyIndex, channelConfiguration,
  // frameLengthFlag=0, dependsOnCoreCoder=0, extensionFlag=0.
  const bits = (2 << 11) | (frequencyIndex << 7) | ((numberOfChannels & 0x0f) << 3)
  return new Uint8Array([(bits >> 8) & 0xff, bits & 0xff])
}

/** Copy any buffer source (ArrayBuffer, SharedArrayBuffer or a view) into bytes. */
function copyBytes(source: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(source)) {
    const view = source as ArrayBufferView
    return new Uint8Array(new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength))
  }
  return new Uint8Array(new Uint8Array(source as ArrayBuffer))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
