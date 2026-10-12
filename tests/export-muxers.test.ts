import { describe, expect, it } from 'vitest'
import { Mp4Muxer } from '../src/engine/export/mp4'
import { WebmMuxer, vint, WEBM_ID } from '../src/engine/export/webm'

/**
 * Container tests: the muxers are the part of the export that cannot be checked
 * by eye, so the files are parsed back here — element/box structure, sample
 * payloads, and the header fields that get patched at the end.
 */

/* ------------------------------------------------------------------ *
 * EBML reader (WebM)
 * ------------------------------------------------------------------ */

interface EbmlElement {
  id: number
  size: number
  offset: number
  /** First byte of the element's payload. */
  bodyStart: number
  end: number
}

function readVint(bytes: Uint8Array, offset: number): { value: number; length: number } {
  const first = bytes[offset]
  let length = 1
  let mask = 0x80
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1
    length += 1
  }
  if (length > 8) throw new Error(`bad vint at ${offset}`)
  let value = first & (mask - 1)
  for (let index = 1; index < length; index += 1) value = value * 256 + bytes[offset + index]
  return { value, length }
}

function readId(bytes: Uint8Array, offset: number): number {
  const first = bytes[offset]
  let length = 1
  let mask = 0x80
  while (length <= 4 && (first & mask) === 0) {
    mask >>= 1
    length += 1
  }
  let value = 0
  for (let index = 0; index < length; index += 1) value = value * 256 + bytes[offset + index]
  return value
}

function idLengthOf(id: number): number {
  if (id >= 0x1000000) return 4
  if (id >= 0x10000) return 3
  if (id >= 0x100) return 2
  return 1
}

/** Flat scan for direct children of a region (enough for these files). */
function children(bytes: Uint8Array, start: number, end: number): EbmlElement[] {
  const out: EbmlElement[] = []
  let offset = start
  while (offset < end) {
    const id = readId(bytes, offset)
    const idLength = idLengthOf(id)
    const size = readVint(bytes, offset + idLength)
    const bodyStart = offset + idLength + size.length
    // Unknown size (0x01FF...) means "until the end of the parent".
    const isUnknown = size.value === 2 ** (7 * size.length) - 1
    const bodySize = isUnknown ? end - bodyStart : size.value
    out.push({ id, size: bodySize, offset, bodyStart, end: bodyStart + bodySize })
    if (isUnknown) break
    offset = bodyStart + bodySize
  }
  return out
}

function childrenWithId(elements: EbmlElement[], id: number): EbmlElement[] {
  return elements.filter((element) => element.id === id)
}

function readFloat(bytes: Uint8Array, element: EbmlElement): number {
  return new DataView(bytes.buffer, bytes.byteOffset + element.bodyStart, 8).getFloat64(0, false)
}

function readString(bytes: Uint8Array, element: EbmlElement): string {
  return new TextDecoder().decode(bytes.subarray(element.bodyStart, element.end))
}

function readUint(bytes: Uint8Array, element: EbmlElement): number {
  let value = 0
  for (let index = 0; index < element.size; index += 1) value = value * 256 + bytes[element.bodyStart + index]
  return value
}

function join(parts: Uint8Array[]): Uint8Array {
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

describe('WebmMuxer', () => {
  const frame = (index: number, size = 8, keyFrame = index % 30 === 0): { data: Uint8Array; timestamp: number; keyFrame: boolean } => ({
    data: new Uint8Array(size).fill(index & 0xff),
    timestamp: Math.round((index * 1_000_000) / 30),
    keyFrame,
  })

  it('writes an EBML header, tracks and patched duration', () => {
    const muxer = new WebmMuxer()
    muxer.initialize({ width: 1280, height: 720, codec: 'vp9' })
    const total = 121
    for (let index = 0; index < total; index += 1) muxer.addFrame(frame(index))
    const bytes = join(muxer.finish())

    const top = children(bytes, 0, bytes.length)
    expect(top[0].id).toBe(WEBM_ID.ebml)
    const ebml = children(bytes, top[0].bodyStart, top[0].end)
    const docType = ebml.find((element) => element.id === WEBM_ID.docType)
    expect(docType && readString(bytes, docType)).toBe('webm')

    const segment = top[1]
    expect(segment.id).toBe(WEBM_ID.segment)
    const segmentBody = segment.bodyStart
    const infoElements = childrenWithId(children(bytes, segmentBody, segment.end), WEBM_ID.info)
    expect(infoElements).toHaveLength(1)
    const info = children(bytes, infoElements[0].bodyStart, infoElements[0].end)
    // Patching the duration must not disturb the fixed fields before it.
    expect(readString(bytes, info.find((element) => element.id === WEBM_ID.muxingApp)!)).toBe('web-gource')
    expect(readString(bytes, info.find((element) => element.id === WEBM_ID.writingApp)!)).toBe('web-gource')
    expect(readUint(bytes, info.find((element) => element.id === WEBM_ID.timecodeScale)!)).toBe(1_000_000)
    const duration = info.find((element) => element.id === WEBM_ID.duration)
    expect(duration).toBeDefined()
    // 121 frames at 30 fps, inclusive of t = 0 → 4.033 s.
    expect(readFloat(bytes, duration!)).toBeCloseTo(4033.3, 0)

    const tracks = childrenWithId(children(bytes, segmentBody, segment.end), WEBM_ID.tracks)
    const trackEntry = children(bytes, tracks[0].bodyStart, tracks[0].end)[0]
    const trackChildren = children(bytes, trackEntry.bodyStart, trackEntry.end)
    expect(readString(bytes, trackChildren.find((element) => element.id === WEBM_ID.codecId)!)).toBe('V_VP9')
    const video = trackChildren.find((element) => element.id === WEBM_ID.video)!
    const videoChildren = children(bytes, video.bodyStart, video.end)
    expect(readUint(bytes, videoChildren.find((element) => element.id === WEBM_ID.pixelWidth)!)).toBe(1280)
    expect(readUint(bytes, videoChildren.find((element) => element.id === WEBM_ID.pixelHeight)!)).toBe(720)
    expect(muxer.frameCount).toBe(total)
  })

  it('starts a cluster per keyframe and keeps every frame', () => {
    const muxer = new WebmMuxer()
    muxer.initialize({ width: 640, height: 360, codec: 'vp8' })
    const total = 70
    for (let index = 0; index < total; index += 1) muxer.addFrame(frame(index))
    const bytes = join(muxer.finish())

    const top = children(bytes, 0, bytes.length)
    const segment = top[1]
    const segmentChildren = children(bytes, segment.bodyStart, segment.end)
    const clusters = childrenWithId(segmentChildren, WEBM_ID.cluster)
    // 70 frames at one keyframe per 30 frames → 3 clusters (0, 30, 60).
    expect(clusters).toHaveLength(3)

    let blocks = 0
    let lastTimecode = -1
    for (const cluster of clusters) {
      const clusterChildren = children(bytes, cluster.bodyStart, cluster.end)
      const timecode = readUint(bytes, clusterChildren.find((element) => element.id === WEBM_ID.timecode)!)
      expect(timecode).toBeGreaterThanOrEqual(lastTimecode)
      lastTimecode = timecode
      blocks += childrenWithId(clusterChildren, WEBM_ID.simpleBlock).length
    }
    expect(blocks).toBe(total)

    // The first SimpleBlock is a keyframe carrying the first frame's bytes.
    const firstCluster = clusters[0]
    const firstBlock = children(bytes, firstCluster.bodyStart, firstCluster.end).find(
      (element) => element.id === WEBM_ID.simpleBlock,
    )!
    const start = firstBlock.bodyStart
    expect(bytes[start]).toBe(0x81) // track 1
    expect(bytes[start + 3]).toBe(0x80) // keyframe flag
    expect(bytes[start + 4]).toBe(0) // first frame payload
  })
})

describe('vint', () => {
  it('encodes sizes in the shortest form and round-trips', () => {
    for (const value of [0, 1, 126, 127, 128, 1000, 16382, 16383, 20000, 2 ** 21 - 2, 5_000_000]) {
      const encoded = vint(value)
      const decoded = readVint(encoded, 0)
      expect(decoded.value).toBe(value)
      expect(decoded.length).toBe(encoded.length)
    }
  })
})

/* ------------------------------------------------------------------ *
 * Box reader (MP4)
 * ------------------------------------------------------------------ */

interface Box {
  type: string
  start: number
  end: number
  bodyStart: number
}

function boxes(bytes: Uint8Array, start = 0, end = bytes.length): Box[] {
  const out: Box[] = []
  let offset = start
  while (offset + 8 <= end) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8)
    const size = view.getUint32(0)
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    if (size < 8) break
    out.push({ type, start: offset, end: offset + size, bodyStart: offset + 8 })
    offset += size
  }
  return out
}

/** Direct child box, optionally skipping a full-box header and entry count. */
function child(bytes: Uint8Array, parent: Box | null, type: string, skip = 0): Box | null {
  const start = parent ? parent.bodyStart + skip : skip
  const end = parent ? parent.end : bytes.length
  return boxes(bytes, start, end).find((box) => box.type === type) ?? null
}

describe('Mp4Muxer', () => {
  const description = new Uint8Array([1, 0x42, 0xc0, 0x33, 0xff, 0xe1, 0x00, 0x03, 1, 2, 3, 0x01, 0x00, 0x02, 4, 5])
  const frame = (index: number, size = 10, keyFrame = index % 30 === 0): { data: Uint8Array; timestamp: number; duration: number; keyFrame: boolean; decodeTime: number } => ({
    data: new Uint8Array(size).fill(index & 0xff),
    timestamp: Math.round((index * 1_000_000) / 30),
    duration: Math.round(1_000_000 / 30),
    keyFrame,
    decodeTime: Math.round((index * 1_000_000) / 30),
  })

  it('writes ftyp, moov with avcC, and one fragment per keyframe', () => {
    const muxer = new Mp4Muxer()
    muxer.initialize({ width: 1920, height: 1080, description })
    const total = 61
    for (let index = 0; index < total; index += 1) muxer.addFrame(frame(index))
    const bytes = join(muxer.finish())

    const top = boxes(bytes)
    expect(top.map((box) => box.type)).toEqual(['ftyp', 'moov', 'moof', 'mdat', 'moof', 'mdat', 'moof', 'mdat'])

    const moov = child(bytes, null, 'moov')!
    const trak = child(bytes, moov, 'trak')!
    const mdia = child(bytes, trak, 'mdia')!
    const minf = child(bytes, mdia, 'minf')!
    const stbl = child(bytes, minf, 'stbl')!
    const stsd = child(bytes, stbl, 'stsd')!
    // stsd is a full box: version/flags plus the entry count precede avc1.
    const avc1 = child(bytes, stsd, 'avc1', 8)!
    // avcC follows the 78-byte fixed sample-entry header.
    const avcC = child(bytes, avc1, 'avcC', 78)!
    expect(Array.from(bytes.subarray(avcC.bodyStart, avcC.end))).toEqual(Array.from(description))

    const mvhd = child(bytes, moov, 'mvhd')!
    // mvhd v0: version/flags, creation, modification, timescale, duration.
    expect(new DataView(bytes.buffer, bytes.byteOffset + mvhd.bodyStart + 16, 4).getUint32(0)).toBe(2033)

    const moofs = top.filter((box) => box.type === 'moof')
    expect(moofs).toHaveLength(3)
    let samples = 0
    for (const moof of moofs) {
      const traf = child(bytes, moof, 'traf')!
      const trun = child(bytes, traf, 'trun')!
      // version 0, flags 0x000701
      expect(bytes[trun.bodyStart]).toBe(0)
      const sampleCount = new DataView(bytes.buffer, bytes.byteOffset + trun.bodyStart + 4, 4).getUint32(0)
      const dataOffset = new DataView(bytes.buffer, bytes.byteOffset + trun.bodyStart + 8, 4).getUint32(0)
      samples += sampleCount
      // The data offset points at the first sample in the mdat that follows.
      const mdat = boxes(bytes, moof.start, moof.end + 16).find((box) => box.type === 'mdat')!
      expect(moof.start + dataOffset).toBe(mdat.bodyStart)
    }
    expect(samples).toBe(total)
    expect(muxer.frameCount).toBe(total)
  })

  it('keeps sample payloads byte exact', () => {
    const muxer = new Mp4Muxer()
    muxer.initialize({ width: 320, height: 240, description })
    const frames = [frame(0, 6), frame(1, 4), frame(2, 9)]
    for (const value of frames) muxer.addFrame(value)
    const bytes = join(muxer.finish())

    const mdat = boxes(bytes).filter((box) => box.type === 'mdat')
    const payload = join(mdat.map((box) => bytes.subarray(box.bodyStart, box.end)))
    const expected = join(frames.map((value) => value.data))
    expect(Array.from(payload)).toEqual(Array.from(expected))
  })

  it('refuses to initialize without a decoder description', () => {
    const muxer = new Mp4Muxer()
    expect(() => muxer.initialize({ width: 640, height: 360, description: new Uint8Array(0) })).toThrow(/avcC/)
  })
})
