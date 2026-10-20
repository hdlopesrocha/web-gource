/**
 * Minimal WebM (Matroska) muxer for a single video track.
 *
 * WebCodecs hands back *encoded* chunks, not a container, so the container is
 * written here — no dependency, and only the fields a player needs: the EBML
 * header, Segment, Info (with the duration), Tracks, and one Cluster per
 * keyframe. Frames are pushed in as they arrive, so the exporter never holds raw
 * frames; only the compressed stream (plus a fixed-size, back-patched header) is
 * kept in memory.
 *
 * Layout notes:
 *  - `TimecodeScale` is the Matroska default (1 ms) and every frame time is
 *    derived from its absolute timestamp, so millisecond rounding never
 *    accumulates.
 *  - The Segment uses the unknown-size form, so the file can be streamed; the
 *    Duration in `Info` is patched once the last frame is known, in place.
 *  - There is no Cues index (that would need the total size up front). Clusters
 *    carry absolute timecodes, which is what players scan to seek.
 */

export type WebmCodec = 'vp9' | 'vp8' | 'av1'

export interface WebmVideoInfo {
  width: number
  height: number
  codec: WebmCodec
  /** Nominal frame duration in microseconds (the export's frame rate). */
  frameDurationUs?: number
}

/** Optional Opus audio track (the background music). */
export interface WebmAudioInfo {
  /** Opus decoder description (OpusHead), as required by Matroska. */
  codecPrivate: Uint8Array
  sampleRate: number
  numberOfChannels: number
  /** Encoder delay in nanoseconds, written as CodecDelay. */
  codecDelayNs?: number
  /** Seek pre-roll in nanoseconds (80 ms is the Opus recommendation). */
  seekPreRollNs?: number
  /** Nominal packet duration in microseconds, used for the duration patch. */
  frameDurationUs?: number
}

const CODEC_IDS: Record<WebmCodec, string> = {
  vp9: 'V_VP9',
  vp8: 'V_VP8',
  av1: 'V_AV1',
}

/** Matroska default: one timecode unit is a millisecond. */
const TIMECODE_SCALE_NS = 1_000_000
/** Fallback frame duration when the caller does not state one (60 fps). */
const FALLBACK_FRAME_DURATION_US = Math.round(1_000_000 / 60)

/* ------------------------------------------------------------------ *
 * EBML primitives
 * ------------------------------------------------------------------ */

/** Variable-length integer (EBML size encoding), shortest form. */
export function vint(value: number): Uint8Array {
  for (let length = 1; length <= 8; length += 1) {
    const maximum = 2 ** (7 * length) - 2
    if (value <= maximum) {
      const bytes = new Uint8Array(length)
      let remaining = value
      for (let index = length - 1; index >= 0; index -= 1) {
        bytes[index] = remaining & 0xff
        remaining = Math.floor(remaining / 256)
      }
      bytes[0] |= 0x80 >> (length - 1)
      return bytes
    }
  }
  throw new Error(`WebM: size ${value} is too large for EBML`)
}

function idLength(id: number): number {
  if (id >= 0x1000000) return 4
  if (id >= 0x10000) return 3
  if (id >= 0x100) return 2
  return 1
}

/** Big-endian unsigned integer of a fixed width. */
export function uintBytes(value: number, width: number): Uint8Array {
  const bytes = new Uint8Array(width)
  let remaining = Math.max(0, Math.round(value))
  for (let index = width - 1; index >= 0; index -= 1) {
    bytes[index] = remaining % 256
    remaining = Math.floor(remaining / 256)
  }
  return bytes
}

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Element with an explicit size. */
export function element(id: number, body: Uint8Array): Uint8Array {
  return concat([uintBytes(id, idLength(id)), vint(body.length), body])
}

/** Element whose size is not known yet (used for the Segment). */
function unknownElement(id: number, body: Uint8Array): Uint8Array {
  const unknownSize = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
  return concat([uintBytes(id, idLength(id)), unknownSize, body])
}

function uintElement(id: number, value: number, width: number): Uint8Array {
  return element(id, uintBytes(value, width))
}

function floatElement(id: number, value: number): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setFloat64(0, value, false)
  return element(id, bytes)
}

function stringElement(id: number, value: string): Uint8Array {
  return element(id, new TextEncoder().encode(value))
}

/* ------------------------------------------------------------------ *
 * Muxer
 * ------------------------------------------------------------------ */

export const WEBM_ID = {
  ebml: 0x1a45dfa3,
  ebmlVersion: 0x4286,
  ebmlReadVersion: 0x42f7,
  ebmlMaxIdLength: 0x42f2,
  ebmlMaxSizeLength: 0x42f3,
  docType: 0x4282,
  docTypeVersion: 0x4287,
  docTypeReadVersion: 0x4285,
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  muxingApp: 0x4d80,
  writingApp: 0x5741,
  duration: 0x4489,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackUid: 0x73c5,
  trackType: 0x83,
  flagLacing: 0x9c,
  flagDefault: 0x88,
  flagEnabled: 0xb9,
  language: 0x22b59c,
  codecId: 0x86,
  codecPrivate: 0x63a2,
  codecDelay: 0x56aa,
  seekPreRoll: 0x56bb,
  defaultDuration: 0x23e383,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  audio: 0xe1,
  samplingFrequency: 0xb5,
  channels: 0x9f,
  cluster: 0x1f43b675,
  timecode: 0xe7,
  simpleBlock: 0xa3,
} as const

export interface WebmFrame {
  /** Encoded frame bytes. */
  data: Uint8Array
  /** Presentation timestamp in microseconds. */
  timestamp: number
  keyFrame: boolean
}

/** Start a new cluster at least this often, even without a keyframe. */
const MAX_CLUSTER_FRAMES = 150

export class WebmMuxer {
  private parts: Uint8Array[] = []
  private header: Uint8Array | null = null
  /** Absolute offset of the patchable Duration payload inside the header. */
  private durationOffset = -1
  private info: WebmVideoInfo | null = null
  private audio: WebmAudioInfo | null = null
  private cluster: Uint8Array[] = []
  private clusterTimecode = 0
  private clusterFrames = 0
  private frames = 0
  private audioFrames = 0
  private written = 0
  private lastTimestamp = 0
  private lastAudioTimestamp = 0
  private finished = false

  get bytesWritten(): number {
    return this.written
  }

  get frameCount(): number {
    return this.frames
  }

  get audioFrameCount(): number {
    return this.audioFrames
  }

  /**
   * Write the container header. Call once, before adding frames.
   *
   * `audio` is optional: without it the file contains only the video track.
   */
  initialize(info: WebmVideoInfo, audio?: WebmAudioInfo): void {
    if (this.info) return
    this.info = info
    this.audio = audio ?? null
    const built = buildHeader(info, 0, this.audio ?? undefined)
    this.header = built.bytes
    this.durationOffset = built.durationOffset
    this.parts.push(this.header)
    this.written += this.header.length
  }

  /**
   * Push one encoded video frame.
   *
   * A cluster starts at every keyframe (and when one grows too large), so
   * memory stays flat and every cluster begins with a seekable keyframe.
   */
  addFrame(frame: WebmFrame): void {
    if (this.finished) throw new Error('WebM: the muxer has already been finished')
    if (!this.info) throw new Error('WebM: initialize() must be called first')
    const timecode = Math.round(frame.timestamp / 1000)
    const needsCluster = this.cluster.length === 0 || (frame.keyFrame && this.clusterFrames > 0) || this.clusterFrames >= MAX_CLUSTER_FRAMES
    if (needsCluster) {
      this.flushCluster()
      this.clusterTimecode = timecode
    }
    this.addBlock(1, timecode, frame.keyFrame ? 0x80 : 0x00, frame.data)
    this.frames += 1
    this.lastTimestamp = frame.timestamp
  }

  /** Push one encoded Opus packet into the current cluster. */
  addAudioFrame(frame: WebmFrame): void {
    if (this.finished) throw new Error('WebM: the muxer has already been finished')
    if (!this.info) throw new Error('WebM: initialize() must be called first')
    if (!this.audio) throw new Error('WebM: this file was initialized without an audio track')
    const timecode = Math.round(frame.timestamp / 1000)
    if (this.cluster.length === 0 || this.clusterFrames >= MAX_CLUSTER_FRAMES) {
      this.flushCluster()
      this.clusterTimecode = timecode
    }
    const relative = timecode - this.clusterTimecode
    if (relative > 32767 || relative < -32768) {
      this.flushCluster()
      this.clusterTimecode = timecode
    }
    // Audio packets are always keyframes from Matroska's point of view.
    this.addBlock(2, timecode, 0x80, frame.data)
    this.audioFrames += 1
    this.lastAudioTimestamp = frame.timestamp
  }

  private addBlock(track: number, timecode: number, flags: number, data: Uint8Array): void {
    const relative = timecode - this.clusterTimecode
    if (relative > 32767 || relative < -32768) {
      this.flushCluster()
      this.clusterTimecode = timecode
    }
    this.cluster.push(
      element(
        WEBM_ID.simpleBlock,
        concat([vint(track), uintBytes(timecode - this.clusterTimecode, 2), new Uint8Array([flags]), data]),
      ),
    )
    this.clusterFrames += 1
  }

  private flushCluster(): void {
    if (this.cluster.length === 0) return
    const bytes = element(
      WEBM_ID.cluster,
      concat([uintElement(WEBM_ID.timecode, this.clusterTimecode, 4), ...this.cluster]),
    )
    this.parts.push(bytes)
    this.written += bytes.length
    this.cluster = []
    this.clusterFrames = 0
  }

  /** Flush the last cluster, patch the duration and return the file parts. */
  finish(): Uint8Array[] {
    if (!this.info) throw new Error('WebM: initialize() must be called first')
    if (!this.finished) {
      this.flushCluster()
      // Duration is measured in TimecodeScale units (milliseconds here).
      const frameDurationUs = this.info.frameDurationUs ?? FALLBACK_FRAME_DURATION_US
      const videoEnd = this.lastTimestamp + frameDurationUs
      const audioEnd =
        this.audio && this.audioFrames > 0
          ? this.lastAudioTimestamp + (this.audio.frameDurationUs ?? 20_000)
          : 0
      const durationMs = Math.max(videoEnd, audioEnd) / 1000
      const payload = new Uint8Array(8)
      new DataView(payload.buffer).setFloat64(0, durationMs, false)
      if (this.header && this.durationOffset >= 0) this.header.set(payload, this.durationOffset)
      this.finished = true
    }
    return this.parts
  }

  /** The finished file as a Blob (calls `finish`). */
  finishBlob(): Blob {
    return new Blob(this.finish() as BlobPart[], { type: 'video/webm' })
  }
}

/**
 * EBML header + open-ended Segment with Info and Tracks.
 *
 * The Duration payload is written with a fixed size and its absolute offset is
 * returned, so `finish()` can patch the value without moving any bytes.
 */
export function buildHeader(
  info: WebmVideoInfo,
  durationMs: number,
  audio?: WebmAudioInfo,
): { bytes: Uint8Array; durationOffset: number } {
  const ebml = element(
    WEBM_ID.ebml,
    concat([
      uintElement(WEBM_ID.ebmlVersion, 1, 1),
      uintElement(WEBM_ID.ebmlReadVersion, 1, 1),
      uintElement(WEBM_ID.ebmlMaxIdLength, 4, 1),
      uintElement(WEBM_ID.ebmlMaxSizeLength, 8, 1),
      stringElement(WEBM_ID.docType, 'webm'),
      uintElement(WEBM_ID.docTypeVersion, 2, 1),
      uintElement(WEBM_ID.docTypeReadVersion, 2, 1),
    ]),
  )

  const videoTrack = element(
    WEBM_ID.trackEntry,
    concat([
      uintElement(WEBM_ID.trackNumber, 1, 1),
      uintElement(WEBM_ID.trackUid, 1, 8),
      uintElement(WEBM_ID.trackType, 1, 1),
      uintElement(WEBM_ID.flagEnabled, 1, 1),
      uintElement(WEBM_ID.flagDefault, 1, 1),
      uintElement(WEBM_ID.flagLacing, 0, 1),
      stringElement(WEBM_ID.language, 'und'),
      stringElement(WEBM_ID.codecId, CODEC_IDS[info.codec]),
      uintElement(
        WEBM_ID.defaultDuration,
        Math.round((info.frameDurationUs ?? FALLBACK_FRAME_DURATION_US) * 1000),
        4,
      ),
      element(
        WEBM_ID.video,
        concat([uintElement(WEBM_ID.pixelWidth, info.width, 2), uintElement(WEBM_ID.pixelHeight, info.height, 2)]),
      ),
    ]),
  )

  const trackEntries = [videoTrack]
  if (audio) {
    trackEntries.push(
      element(
        WEBM_ID.trackEntry,
        concat([
          uintElement(WEBM_ID.trackNumber, 2, 1),
          uintElement(WEBM_ID.trackUid, 2, 8),
          uintElement(WEBM_ID.trackType, 2, 1),
          uintElement(WEBM_ID.flagEnabled, 1, 1),
          uintElement(WEBM_ID.flagDefault, 0, 1),
          uintElement(WEBM_ID.flagLacing, 0, 1),
          stringElement(WEBM_ID.language, 'und'),
          stringElement(WEBM_ID.codecId, 'A_OPUS'),
          element(WEBM_ID.codecPrivate, audio.codecPrivate),
          uintElement(WEBM_ID.codecDelay, Math.round(audio.codecDelayNs ?? 0), 4),
          uintElement(WEBM_ID.seekPreRoll, Math.round(audio.seekPreRollNs ?? 80_000_000), 4),
          element(
            WEBM_ID.audio,
            concat([
              floatElement(WEBM_ID.samplingFrequency, audio.sampleRate),
              uintElement(WEBM_ID.channels, audio.numberOfChannels, 1),
            ]),
          ),
        ]),
      ),
    )
  }

  const infoBody = concat([
    uintElement(WEBM_ID.timecodeScale, TIMECODE_SCALE_NS, 4),
    stringElement(WEBM_ID.muxingApp, 'web-gource'),
    stringElement(WEBM_ID.writingApp, 'web-gource'),
    floatElement(WEBM_ID.duration, durationMs),
  ])
  const infoElement = element(WEBM_ID.info, infoBody)
  const segment = unknownElement(
    WEBM_ID.segment,
    concat([infoElement, element(WEBM_ID.tracks, concat(trackEntries))]),
  )
  const bytes = concat([ebml, segment])

  // Absolute offset of the 8 duration bytes. The Duration element is last in the
  // Info body, so its payload is the final 8 bytes; the body itself starts after
  // the EBML header, the 4-byte Segment id, its 8-byte unknown size, and the
  // Info element's own id and size (5 bytes for these fixed fields).
  const infoElementStart = ebml.length + 4 + 8
  const infoHeaderLength = 4 + vint(infoBody.length).length
  const durationOffset = infoElementStart + infoHeaderLength + infoBody.length - 8
  return { bytes, durationOffset }
}
