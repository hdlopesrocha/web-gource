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
  defaultDuration: 0x23e383,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
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
  private cluster: Uint8Array[] = []
  private clusterTimecode = 0
  private clusterFrames = 0
  private frames = 0
  private written = 0
  private lastTimestamp = 0
  private finished = false

  get bytesWritten(): number {
    return this.written
  }

  get frameCount(): number {
    return this.frames
  }

  /** Write the container header. Call once, before `addFrame`. */
  initialize(info: WebmVideoInfo): void {
    if (this.info) return
    this.info = info
    const built = buildHeader(info, 0)
    this.header = built.bytes
    this.durationOffset = built.durationOffset
    this.parts.push(this.header)
    this.written += this.header.length
  }

  /**
   * Push one encoded frame.
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
    const relative = timecode - this.clusterTimecode
    if (relative > 32767 || relative < -32768) {
      this.flushCluster()
      this.clusterTimecode = timecode
    }
    const flags = frame.keyFrame ? 0x80 : 0x00
    this.cluster.push(
      element(
        WEBM_ID.simpleBlock,
        concat([vint(1), uintBytes(timecode - this.clusterTimecode, 2), new Uint8Array([flags]), frame.data]),
      ),
    )
    this.clusterFrames += 1
    this.frames += 1
    this.lastTimestamp = frame.timestamp
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
      const durationMs = (this.lastTimestamp + frameDurationUs) / 1000
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

  const track = element(
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

  const infoBody = concat([
    uintElement(WEBM_ID.timecodeScale, TIMECODE_SCALE_NS, 4),
    stringElement(WEBM_ID.muxingApp, 'web-gource'),
    stringElement(WEBM_ID.writingApp, 'web-gource'),
    floatElement(WEBM_ID.duration, durationMs),
  ])
  const infoElement = element(WEBM_ID.info, infoBody)
  const segment = unknownElement(WEBM_ID.segment, concat([infoElement, element(WEBM_ID.tracks, track)]))
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
