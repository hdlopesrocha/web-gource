/**
 * Minimal fragmented MP4 (fMP4) muxer for a single H.264 track.
 *
 * Used for the optional MP4 output: WebCodecs produces encoded AVC chunks plus
 * the AVCC decoder description (`avcC`), and this writer turns them into
 * `ftyp` + `moov` + `moof`/`mdat` fragments that ffmpeg, Chrome and Safari play.
 * As with the WebM muxer, samples are streamed in and only compressed data
 * (plus the small, back-patched header) is retained; one fragment is written per
 * keyframe, which bounds memory to about a second of encoded video.
 *
 * Deliberately narrow: one video track plus an optional AAC audio track, no edit
 * lists, no sample groups. Composition offsets are emitted when the encoder
 * reorders frames, so B-frame streams stay in sync.
 */

export interface Mp4VideoInfo {
  width: number
  height: number
  /**
   * AVCC decoder configuration record (the payload of `avcC`), as delivered in
   * `EncodedVideoChunk` metadata. Required: this layout carries no in-band
   * parameter sets.
   */
  description: Uint8Array
  /** Optional AAC audio track (background music). */
  audio?: Mp4AudioInfo
}

/** AAC track metadata for the background music. */
export interface Mp4AudioInfo {
  sampleRate: number
  numberOfChannels: number
  /** AudioSpecificConfig (the payload of `DecoderSpecificInfo`). */
  description: Uint8Array
  /** Nominal bitrate written into the ES descriptor. */
  bitrate?: number
}

export interface Mp4Frame {
  data: Uint8Array
  /** Presentation timestamp in microseconds. */
  timestamp: number
  /** Duration in microseconds. */
  duration: number
  keyFrame: boolean
  /**
   * Decode timestamp in microseconds. Defaults to the presentation timestamp;
   * the exporter sets it to `frame * duration` so reordered streams keep a
   * monotonic decode timeline.
   */
  decodeTime?: number
}

/** One encoded AAC packet. Audio packets are always sync samples. */
export interface Mp4AudioFrame {
  data: Uint8Array
  /** Presentation timestamp in microseconds. */
  timestamp: number
  /** Duration in microseconds. */
  duration: number
}

/** Media timescale: microseconds, matching WebCodecs timestamps. */
const MEDIA_TIMESCALE = 1_000_000
/** Movie timescale (milliseconds), used by mvhd/tkhd/mehd. */
const MOVIE_TIMESCALE = 1000
/** Flush a fragment at least this often, even without a keyframe. */
const MAX_FRAGMENT_SAMPLES = 60

/* ------------------------------------------------------------------ *
 * Byte writer
 * ------------------------------------------------------------------ */

class Buf {
  private chunks: Uint8Array[] = []
  private length = 0
  /** Offset of this buffer's first byte inside the root buffer. */
  private base: number

  constructor(base = 0) {
    this.base = base
  }

  /** Bytes written to this buffer. */
  get localSize(): number {
    return this.length
  }

  /** Absolute offset just past the last written byte (patch point). */
  get absoluteEnd(): number {
    return this.base + this.length
  }

  /** Append bytes; returns their absolute offset. */
  push(bytes: Uint8Array): number {
    const offset = this.base + this.length
    this.chunks.push(bytes)
    this.length += bytes.length
    return offset
  }

  u8(value: number): number {
    return this.push(new Uint8Array([value & 0xff]))
  }

  u16(value: number): number {
    return this.push(new Uint8Array([(value >> 8) & 0xff, value & 0xff]))
  }

  u32(value: number): number {
    const clamped = Math.max(0, Math.round(value))
    return this.push(
      new Uint8Array([
        Math.floor(clamped / 0x1000000) & 0xff,
        Math.floor(clamped / 0x10000) & 0xff,
        Math.floor(clamped / 0x100) & 0xff,
        clamped & 0xff,
      ]),
    )
  }

  /** 64-bit big-endian; values stay well below 2^53 here. */
  u64(value: number): number {
    const clamped = Math.max(0, Math.round(value))
    const offset = this.u32(Math.floor(clamped / 0x100000000))
    this.u32(clamped % 0x100000000)
    return offset
  }

  fourcc(type: string): number {
    const bytes = new Uint8Array(4)
    for (let index = 0; index < 4; index += 1) bytes[index] = type.charCodeAt(index) & 0xff
    return this.push(bytes)
  }

  /** Box with a 32-bit size, written by `body`. */
  box(type: string, body: (buf: Buf) => void): void {
    // The body starts after this box's size and type fields.
    const inner = new Buf(this.base + this.length + 8)
    body(inner)
    this.u32(inner.localSize + 8)
    this.fourcc(type)
    this.push(inner.data())
  }

  /** Box with a version/flags header, written by `body`. */
  fullBox(type: string, version: number, flags: number, body: (buf: Buf) => void): void {
    this.box(type, (buf) => {
      buf.u8(version)
      buf.u8((flags >> 16) & 0xff)
      buf.u8((flags >> 8) & 0xff)
      buf.u8(flags & 0xff)
      body(buf)
    })
  }

  data(): Uint8Array {
    const out = new Uint8Array(this.length)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }
}

/* ------------------------------------------------------------------ *
 * Muxer
 * ------------------------------------------------------------------ */

interface Patch {
  offset: number
  width: number
}

export class Mp4Muxer {
  private header: Uint8Array | null = null
  private patches = new Map<string, Patch>()
  private parts: Uint8Array[] = []
  private info: Mp4VideoInfo | null = null
  private audio: Mp4AudioInfo | null = null
  private sequence = 0
  private samples = 0
  private audioSamples = 0
  private written = 0
  /** End of the last video sample in the media timescale. */
  private lastVideoEnd = 0
  /** End of the last audio sample in the media timescale. */
  private lastAudioEnd = 0
  /** Video samples waiting for a fragment. */
  private pending: Mp4Frame[] = []
  /** Audio samples waiting for a fragment. */
  private pendingAudio: Mp4AudioFrame[] = []
  private finished = false

  get bytesWritten(): number {
    return this.written
  }

  get frameCount(): number {
    return this.samples
  }

  get audioFrameCount(): number {
    return this.audioSamples
  }

  /**
   * Build `ftyp` + `moov`. Must be called once the decoder description (SPS/PPS)
   * is known, i.e. with the first encoded chunk's metadata.
   */
  initialize(info: Mp4VideoInfo): void {
    if (this.info) return
    if (info.description.length === 0) {
      throw new Error('MP4: the encoder did not provide an AVC decoder description (avcC)')
    }
    this.info = info
    this.audio = info.audio ?? null
    const buffer = new Buf()
    buffer.box('ftyp', (buf) => {
      buf.fourcc('isom')
      buf.u32(0x200)
      buf.fourcc('isom')
      buf.fourcc('iso5')
      buf.fourcc('iso6')
      buf.fourcc('avc1')
      buf.fourcc('mp41')
    })

    buffer.box('moov', (moov) => {
      moov.fullBox('mvhd', 0, 0, (buf) => {
        buf.u32(0) // creation_time
        buf.u32(0) // modification_time
        buf.u32(MOVIE_TIMESCALE)
        this.patch('mvhd.duration', buf, 4, 0)
        buf.u32(0x00010000) // rate 1.0
        buf.u16(0x0100) // volume 1.0
        buf.u16(0) // reserved
        buf.u32(0)
        buf.u32(0)
        writeMatrix(buf)
        // pre_defined[6] (24 bytes) then next_track_ID.
        buf.push(new Uint8Array(24))
        buf.u32(this.audio ? 3 : 2) // next_track_ID
      })

      this.writeVideoTrak(moov, info)
      if (this.audio) this.writeAudioTrak(moov, this.audio)

      moov.box('mvex', (mvex) => {
        mvex.fullBox('mehd', 0, 0, (buf) => {
          this.patch('mvex.duration', buf, 4, 0)
        })
        mvex.fullBox('trex', 0, 0, (buf) => {
          buf.u32(1) // track_ID
          buf.u32(1) // default_sample_description_index
          buf.u32(0) // default_sample_duration
          buf.u32(0) // default_sample_size
          buf.u32(0) // default_sample_flags
        })
        if (this.audio) {
          mvex.fullBox('trex', 0, 0, (buf) => {
            buf.u32(2) // track_ID
            buf.u32(1) // default_sample_description_index
            buf.u32(0)
            buf.u32(0)
            buf.u32(0)
          })
        }
      })
    })

    this.header = buffer.data()
    this.parts.push(this.header)
    this.written += this.header.length
  }

  /** Video `trak`: AVC sample entry and empty fragment sample tables. */
  private writeVideoTrak(moov: Buf, info: Mp4VideoInfo): void {
    moov.box('trak', (trak) => {
      trak.fullBox('tkhd', 0, 0x000007, (buf) => {
        buf.u32(0)
        buf.u32(0)
        buf.u32(1) // track_ID
        buf.u32(0) // reserved
        this.patch('tkhd.video.duration', buf, 4, 0)
        buf.u32(0)
        buf.u32(0)
        buf.u16(0) // layer
        buf.u16(0) // alternate_group
        buf.u16(0) // volume
        buf.u16(0)
        writeMatrix(buf)
        buf.u32(info.width * 65536)
        buf.u32(info.height * 65536)
      })

      trak.box('mdia', (mdia) => {
        mdia.fullBox('mdhd', 0, 0, (buf) => {
          buf.u32(0)
          buf.u32(0)
          buf.u32(MEDIA_TIMESCALE)
          this.patch('mdhd.video.duration', buf, 4, 0)
          buf.u16(0x55c4) // 'und'
          buf.u16(0)
        })
        mdia.fullBox('hdlr', 0, 0, (buf) => {
          buf.u32(0) // pre_defined
          buf.fourcc('vide')
          buf.u32(0)
          buf.u32(0)
          buf.u32(0)
          buf.u8(0) // empty name
        })
        mdia.box('minf', (minf) => {
          minf.fullBox('vmhd', 0, 1, (buf) => {
            buf.u16(0)
            buf.u16(0)
            buf.u16(0)
            buf.u16(0)
          })
          writeDinf(minf)
          minf.box('stbl', (stbl) => {
            stbl.box('stsd', (buf) => {
              buf.u32(0)
              buf.u32(1)
              buf.box('avc1', (entry) => {
                entry.push(new Uint8Array(6)) // reserved
                entry.u16(1) // data_reference_index
                entry.u16(0)
                entry.u16(0)
                entry.u32(0)
                entry.u32(0)
                entry.u32(0)
                entry.u16(info.width)
                entry.u16(info.height)
                entry.u32(0x00480000) // 72 dpi
                entry.u32(0x00480000)
                entry.u32(0) // reserved
                entry.u16(1) // frame_count
                entry.push(new Uint8Array(32)) // compressor name
                entry.u16(0x0018) // depth
                entry.u16(0xffff) // pre_defined
                entry.box('avcC', (avcc) => {
                  avcc.push(info.description)
                })
              })
            })
            writeEmptySampleTables(stbl)
          })
        })
      })
    })
  }

  /** AAC audio `trak`: `mp4a` sample entry with an `esds` descriptor. */
  private writeAudioTrak(moov: Buf, audio: Mp4AudioInfo): void {
    moov.box('trak', (trak) => {
      trak.fullBox('tkhd', 0, 0x000007, (buf) => {
        buf.u32(0)
        buf.u32(0)
        buf.u32(2) // track_ID
        buf.u32(0) // reserved
        this.patch('tkhd.audio.duration', buf, 4, 0)
        buf.u32(0)
        buf.u32(0)
        buf.u16(0) // layer
        buf.u16(0) // alternate_group
        buf.u16(0x0100) // volume 1.0
        buf.u16(0)
        writeMatrix(buf)
        buf.u32(0) // width
        buf.u32(0) // height
      })

      trak.box('mdia', (mdia) => {
        mdia.fullBox('mdhd', 0, 0, (buf) => {
          buf.u32(0)
          buf.u32(0)
          buf.u32(MEDIA_TIMESCALE)
          this.patch('mdhd.audio.duration', buf, 4, 0)
          buf.u16(0x55c4) // 'und'
          buf.u16(0)
        })
        mdia.fullBox('hdlr', 0, 0, (buf) => {
          buf.u32(0) // pre_defined
          buf.fourcc('soun')
          buf.u32(0)
          buf.u32(0)
          buf.u32(0)
          buf.u8(0) // empty name
        })
        mdia.box('minf', (minf) => {
          minf.fullBox('smhd', 0, 0, (buf) => {
            buf.u16(0) // balance
            buf.u16(0) // reserved
          })
          writeDinf(minf)
          minf.box('stbl', (stbl) => {
            stbl.box('stsd', (buf) => {
              buf.u32(0)
              buf.u32(1)
              buf.box('mp4a', (entry) => {
                entry.push(new Uint8Array(6)) // reserved
                entry.u16(1) // data_reference_index
                entry.u16(0) // version
                entry.u16(0) // revision
                entry.u32(0) // vendor
                entry.u16(audio.numberOfChannels)
                entry.u16(16) // sample size
                entry.u16(0) // pre_defined
                entry.u16(0) // reserved
                entry.u32(audio.sampleRate * 65536)
                entry.box('esds', (esds) => {
                  esds.u8(0) // version
                  esds.u8(0) // flags
                  esds.u8(0)
                  esds.u8(0)
                  esds.push(buildEsds(audio))
                })
              })
            })
            writeEmptySampleTables(stbl)
          })
        })
      })
    })
  }

  /** Reserve a fixed-width field and remember where to patch it at the end. */
  private patch(key: string, buf: Buf, width: number, value: number): void {
    this.patches.set(key, { offset: buf.absoluteEnd, width })
    if (width === 4) buf.u32(value)
    else buf.u64(value)
  }

  /** Queue one encoded video sample; fragments are written per keyframe. */
  addFrame(frame: Mp4Frame): void {
    if (this.finished) throw new Error('MP4: the muxer has already been finished')
    if (!this.info) throw new Error('MP4: initialize() must be called first')
    if (frame.keyFrame && this.pending.length > 0) this.flushVideoFragment()
    this.pending.push(frame)
    if (this.pending.length >= MAX_FRAGMENT_SAMPLES) this.flushVideoFragment()
  }

  /** Queue one encoded AAC packet. Audio fragments are flushed in bounded batches. */
  addAudioFrame(frame: Mp4AudioFrame): void {
    if (this.finished) throw new Error('MP4: the muxer has already been finished')
    if (!this.info) throw new Error('MP4: initialize() must be called first')
    if (!this.audio) throw new Error('MP4: this file was initialized without an audio track')
    this.pendingAudio.push(frame)
    if (this.pendingAudio.length >= MAX_FRAGMENT_SAMPLES) this.flushAudioFragment()
  }

  private flushVideoFragment(): void {
    if (this.pending.length === 0) return
    const samples = this.pending
    this.pending = []
    this.sequence += 1
    const fragment = buildFragment(samples, this.sequence, 1)
    this.parts.push(fragment)
    this.written += fragment.length
    this.samples += samples.length
    const last = samples[samples.length - 1]
    this.lastVideoEnd = Math.max(this.lastVideoEnd, last.timestamp + last.duration)
  }

  private flushAudioFragment(): void {
    if (this.pendingAudio.length === 0) return
    const samples: Mp4Frame[] = this.pendingAudio.map((sample) => ({
      data: sample.data,
      timestamp: sample.timestamp,
      duration: sample.duration,
      keyFrame: true,
      decodeTime: sample.timestamp,
    }))
    this.pendingAudio = []
    this.sequence += 1
    const fragment = buildFragment(samples, this.sequence, 2)
    this.parts.push(fragment)
    this.written += fragment.length
    this.audioSamples += samples.length
    const last = samples[samples.length - 1]
    this.lastAudioEnd = Math.max(this.lastAudioEnd, last.timestamp + last.duration)
  }

  /** Flush the last fragments, patch the durations and return the file parts. */
  finish(): Uint8Array[] {
    if (!this.info) throw new Error('MP4: initialize() must be called first')
    if (!this.finished) {
      this.flushVideoFragment()
      this.flushAudioFragment()
      if (this.header) {
        const mediaEnd = Math.max(this.lastVideoEnd, this.lastAudioEnd)
        const movieEnd = Math.round(mediaEnd / 1000)
        for (const [key, patch] of this.patches) {
          const value =
            key === 'mvhd.duration' || key === 'mvex.duration' || key.startsWith('tkhd.')
              ? movieEnd
              : key === 'mdhd.video.duration'
                ? this.lastVideoEnd
                : key === 'mdhd.audio.duration'
                  ? this.lastAudioEnd
                  : 0
          new DataView(this.header.buffer, this.header.byteOffset + patch.offset, patch.width).setUint32(0, value)
        }
      }
      this.finished = true
    }
    return this.parts
  }

  finishBlob(): Blob {
    return new Blob(this.finish() as BlobPart[], { type: 'video/mp4' })
  }
}

function writeDinf(minf: Buf): void {
  minf.box('dinf', (dinf) => {
    dinf.fullBox('dref', 0, 0, (buf) => {
      buf.u32(1)
      buf.fullBox('url ', 0, 1, () => {
        /* self-contained */
      })
    })
  })
}

/** Sample tables stay empty: every sample lives in a fragment. */
function writeEmptySampleTables(stbl: Buf): void {
  stbl.fullBox('stts', 0, 0, (buf) => buf.u32(0))
  stbl.fullBox('stsc', 0, 0, (buf) => buf.u32(0))
  stbl.fullBox('stsz', 0, 0, (buf) => {
    buf.u32(0)
    buf.u32(0)
  })
  stbl.fullBox('stco', 0, 0, (buf) => buf.u32(0))
}

/** `esds` payload: ES_Descriptor → DecoderConfigDescriptor → AudioSpecificConfig. */
function buildEsds(audio: Mp4AudioInfo): Uint8Array {
  const bitrate = audio.bitrate ?? 128_000
  const decoderSpecific = descriptor(0x05, audio.description)
  const decoderConfig = new Buf()
  decoderConfig.u8(0x40) // objectTypeIndication: MPEG-4 Audio
  decoderConfig.u8(0x15) // streamType: audio (5 << 2) | reserved
  decoderConfig.u8(0) // bufferSizeDB (24-bit)
  decoderConfig.u8(0)
  decoderConfig.u8(0)
  decoderConfig.u32(bitrate) // maxBitrate
  decoderConfig.u32(bitrate) // avgBitrate
  decoderConfig.push(decoderSpecific)

  const slConfig = descriptor(0x06, new Uint8Array([0x02]))
  const es = new Buf()
  es.u16(0) // ES_ID
  es.u8(0) // stream priority / flags
  es.push(descriptor(0x04, decoderConfig.data()))
  es.push(slConfig)
  return descriptor(0x03, es.data())
}

function descriptor(tag: number, body: Uint8Array): Uint8Array {
  const out = new Buf()
  out.u8(tag)
  out.push(descriptorLength(body.length))
  out.push(body)
  return out.data()
}

/** MPEG-4 descriptor length: 7-bit groups, high bit set on continuation bytes. */
function descriptorLength(length: number): Uint8Array {
  const bytes = [length & 0x7f]
  let value = length >>> 7
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80)
    value >>>= 7
  }
  return new Uint8Array(bytes)
}

function writeMatrix(buf: Buf): void {
  // Identity matrix: 16.16 for the top row, 2.30 for the bottom row.
  const values = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]
  for (const value of values) buf.u32(value)
}

/**
 * One `moof` + `mdat` pair.
 *
 * Decode times are derived from the sample order (decode order) with the
 * presentation timestamps as composition offsets, which keeps reordered B-frame
 * streams in sync. The data offset depends on the finished `moof` size, so the
 * moof is built twice: once to measure, once with the real offset.
 */
function buildFragment(samples: Mp4Frame[], sequence: number, trackId: number): Uint8Array {
  const measure = buildMoof(samples, sequence, 0, trackId)
  const dataOffset = measure.length + 8 // mdat header
  const moof = buildMoof(samples, sequence, dataOffset, trackId)

  const out = new Buf()
  out.push(moof)
  const payload = samples.reduce((sum, sample) => sum + sample.data.length, 0)
  out.u32(payload + 8)
  out.fourcc('mdat')
  for (const sample of samples) out.push(sample.data)
  return out.data()
}

function buildMoof(samples: Mp4Frame[], sequence: number, dataOffset: number, trackId: number): Uint8Array {
  const first = samples[0]
  // Decode time: samples are already in decode order, so their decode times are
  // the running sum of the durations.
  const offsets: number[] = []
  for (const sample of samples) {
    const decodeTime = sample.decodeTime ?? sample.timestamp
    offsets.push(Math.round(sample.timestamp - decodeTime))
  }
  const reordered = trackId === 1 && offsets.some((offset) => offset !== 0)

  const moof = new Buf()
  const flags =
    0x000001 | // data-offset-present
    0x000100 | // sample-duration-present
    0x000200 | // sample-size-present
    0x000400 | // sample-flags-present
    (reordered ? 0x000800 : 0) // sample-composition-time-offsets-present

  moof.box('moof', (box) => {
    box.fullBox('mfhd', 0, 0, (buf) => buf.u32(sequence))
    box.box('traf', (traf) => {
      traf.fullBox('tfhd', 0, 0x020000, (buf) => {
        buf.u32(trackId) // track_ID (default-base-is-moof)
      })
      traf.fullBox('tfdt', 1, 0, (buf) => {
        buf.u64(Math.max(0, Math.round(first.decodeTime ?? first.timestamp)))
      })
      traf.fullBox('trun', reordered ? 1 : 0, flags, (buf) => {
        buf.u32(samples.length)
        buf.u32(dataOffset)
        for (let index = 0; index < samples.length; index += 1) {
          const sample = samples[index]
          buf.u32(Math.max(1, Math.round(sample.duration)))
          buf.u32(sample.data.length)
          // Audio packets are all sync samples; video keeps the original flags.
          buf.u32(trackId === 2 ? 0x02000000 : sample.keyFrame ? 0x02000000 : 0x01010000)
          if (reordered) buf.u32(Math.round(offsets[index]))
        }
      })
    })
  })
  return moof.data()
}

