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
  const frame = (index: number, size = 8, keyFrame = index % 60 === 0): { data: Uint8Array; timestamp: number; keyFrame: boolean } => ({
    data: new Uint8Array(size).fill(index & 0xff),
    timestamp: Math.round((index * 1_000_000) / 60),
    keyFrame,
  })

  it('writes an EBML header, tracks and patched duration', () => {
    const muxer = new WebmMuxer()
    // 60 fps, as the exporter configures it.
    muxer.initialize({ width: 1280, height: 720, codec: 'vp9', frameDurationUs: 16_667 })
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
    // 121 frames at 60 fps, inclusive of t = 0 → 2.0167 s.
    expect(readFloat(bytes, duration!)).toBeCloseTo(2016.7, 0)

    const tracks = childrenWithId(children(bytes, segmentBody, segment.end), WEBM_ID.tracks)
    const trackEntry = children(bytes, tracks[0].bodyStart, tracks[0].end)[0]
    const trackChildren = children(bytes, trackEntry.bodyStart, trackEntry.end)
    expect(readString(bytes, trackChildren.find((element) => element.id === WEBM_ID.codecId)!)).toBe('V_VP9')
    // The track declares the export's frame duration (60 fps → 16 667 µs).
    expect(readUint(bytes, trackChildren.find((element) => element.id === WEBM_ID.defaultDuration)!)).toBe(16_667_000)
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
    // 70 frames at one keyframe per 60 frames → 2 clusters (0, 60).
    expect(clusters).toHaveLength(2)

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

  it('writes an Opus track and interleaves its packets with the video', () => {
    const muxer = new WebmMuxer()
    const opusHead = new Uint8Array(19)
    opusHead.set(new TextEncoder().encode('OpusHead'))
    opusHead[8] = 1
    opusHead[9] = 2
    muxer.initialize(
      { width: 1280, height: 720, codec: 'vp9', frameDurationUs: 16_667 },
      {
        codecPrivate: opusHead,
        sampleRate: 48_000,
        numberOfChannels: 2,
        codecDelayNs: 6_500_000,
        seekPreRollNs: 80_000_000,
        frameDurationUs: 20_000,
      },
    )

    const total = 121
    const audioPackets: { timestamp: number; data: Uint8Array }[] = []
    let audioIndex = 0
    for (let index = 0; index < total; index += 1) {
      const video = frame(index)
      muxer.addFrame(video)
      while (audioIndex < 110 && audioIndex * 20_000 <= video.timestamp) {
        const data = new Uint8Array([2, audioIndex & 0xff, 0xaa])
        muxer.addAudioFrame({ data, timestamp: audioIndex * 20_000, keyFrame: true })
        audioPackets.push({ timestamp: audioIndex * 20_000, data })
        audioIndex += 1
      }
    }
    // Audio may outlast the video: the duration is the end of the longest track.
    while (audioIndex < 110) {
      const data = new Uint8Array([2, audioIndex & 0xff, 0xaa])
      muxer.addAudioFrame({ data, timestamp: audioIndex * 20_000, keyFrame: true })
      audioPackets.push({ timestamp: audioIndex * 20_000, data })
      audioIndex += 1
    }
    const bytes = join(muxer.finish())

    const top = children(bytes, 0, bytes.length)
    const segment = top[1]
    const segmentChildren = children(bytes, segment.bodyStart, segment.end)
    const tracks = childrenWithId(segmentChildren, WEBM_ID.tracks)
    const trackEntries = children(bytes, tracks[0].bodyStart, tracks[0].end)
    expect(trackEntries).toHaveLength(2)

    const audioTrack = children(bytes, trackEntries[1].bodyStart, trackEntries[1].end)
    expect(readString(bytes, audioTrack.find((element) => element.id === WEBM_ID.codecId)!)).toBe('A_OPUS')
    expect(readUint(bytes, audioTrack.find((element) => element.id === WEBM_ID.trackNumber)!)).toBe(2)
    expect(readUint(bytes, audioTrack.find((element) => element.id === WEBM_ID.codecDelay)!)).toBe(6_500_000)
    expect(readUint(bytes, audioTrack.find((element) => element.id === WEBM_ID.seekPreRoll)!)).toBe(80_000_000)
    const privateBytes = audioTrack.find((element) => element.id === WEBM_ID.codecPrivate)!
    expect(Array.from(bytes.subarray(privateBytes.bodyStart, privateBytes.end))).toEqual(Array.from(opusHead))
    const audioElement = audioTrack.find((element) => element.id === WEBM_ID.audio)!
    const audioChildren = children(bytes, audioElement.bodyStart, audioElement.end)
    expect(readFloat(bytes, audioChildren.find((element) => element.id === WEBM_ID.samplingFrequency)!)).toBe(48_000)
    expect(readUint(bytes, audioChildren.find((element) => element.id === WEBM_ID.channels)!)).toBe(2)

    const blocks: { track: number; data: Uint8Array; flags: number }[] = []
    for (const cluster of childrenWithId(segmentChildren, WEBM_ID.cluster)) {
      for (const block of childrenWithId(children(bytes, cluster.bodyStart, cluster.end), WEBM_ID.simpleBlock)) {
        const track = readVint(bytes, block.bodyStart)
        const relative = (bytes[block.bodyStart + track.length] << 8) | bytes[block.bodyStart + track.length + 1]
        const signed = relative >= 0x8000 ? relative - 0x10000 : relative
        const flags = bytes[block.bodyStart + track.length + 2]
        const dataStart = block.bodyStart + track.length + 3
        const timecode = readUint(
          bytes,
          children(bytes, cluster.bodyStart, cluster.end).find((element) => element.id === WEBM_ID.timecode)!,
        )
        blocks.push({ track: track.value, flags, data: bytes.subarray(dataStart, block.end) })
        expect(timecode + signed).toBeGreaterThanOrEqual(0)
      }
    }
    expect(blocks.filter((block) => block.track === 2)).toHaveLength(audioPackets.length)
    expect(blocks.filter((block) => block.track === 1)).toHaveLength(total)
    for (const block of blocks.filter((entry) => entry.track === 2)) {
      expect(block.flags).toBe(0x80)
      expect(block.data[0]).toBe(2)
    }
    expect(muxer.audioFrameCount).toBe(audioPackets.length)

    const info = children(bytes, childrenWithId(segmentChildren, WEBM_ID.info)[0].bodyStart, childrenWithId(segmentChildren, WEBM_ID.info)[0].end)
    const duration = info.find((element) => element.id === WEBM_ID.duration)!
    // The audio ends at 2.2 s, after the final video frame (2.0167 s).
    expect(readFloat(bytes, duration)).toBeCloseTo(2200, 3)
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

function containsSequence(haystack: Uint8Array, needle: Uint8Array): boolean {
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let match = true
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[start + index] !== needle[index]) {
        match = false
        break
      }
    }
    if (match) return true
  }
  return false
}

function readBoxUint32(bytes: Uint8Array, box: Box, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + box.bodyStart + offset, 4).getUint32(0)
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
    expect(mvhd.end - mvhd.start).toBe(108)
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

  it('writes an AAC track with esds and separate audio fragments', () => {
    const audioDescription = new Uint8Array([0x11, 0x88])
    const muxer = new Mp4Muxer()
    muxer.initialize({
      width: 1280,
      height: 720,
      description,
      audio: {
        sampleRate: 48_000,
        numberOfChannels: 1,
        description: audioDescription,
        bitrate: 128_000,
      },
    })

    const total = 61
    const audioTotal = 110
    let audioIndex = 0
    const addAudioThrough = (timestamp: number): void => {
      while (audioIndex < audioTotal && audioIndex * 20_000 <= timestamp) {
        muxer.addAudioFrame({
          data: new Uint8Array([audioIndex & 0xff, 0xaa]),
          timestamp: audioIndex * 20_000,
          duration: 20_000,
        })
        audioIndex += 1
      }
    }
    for (let index = 0; index < total; index += 1) {
      const video = frame(index)
      muxer.addFrame(video)
      addAudioThrough(video.timestamp)
    }
    // The music runs slightly past the final video frame.
    addAudioThrough(2_200_000)
    const bytes = join(muxer.finish())

    const top = boxes(bytes)
    const moov = top.find((box) => box.type === 'moov')!
    const traks = boxes(bytes, moov.bodyStart, moov.end).filter((box) => box.type === 'trak')
    expect(traks).toHaveLength(2)

    const audioTrak = traks[1]
    const mdia = child(bytes, audioTrak, 'mdia')!
    const mdhd = child(bytes, mdia, 'mdhd')!
    // mdhd v0: version/flags, creation, modification, timescale, duration.
    expect(readBoxUint32(bytes, mdhd, 12)).toBe(1_000_000)
    expect(readBoxUint32(bytes, mdhd, 16)).toBe(2_200_000)

    const hdlr = child(bytes, mdia, 'hdlr')!
    expect(String.fromCharCode(...bytes.subarray(hdlr.bodyStart + 8, hdlr.bodyStart + 12))).toBe('soun')
    const minf = child(bytes, mdia, 'minf')!
    const stbl = child(bytes, minf, 'stbl')!
    const stsd = child(bytes, stbl, 'stsd')!
    const mp4a = child(bytes, stsd, 'mp4a', 8)!
    expect(mp4a).not.toBeNull()
    // Audio sample entry fixed fields use 16.16 for the sample rate.
    expect(readBoxUint32(bytes, mp4a, 24)).toBe(48_000 * 65536)
    const esds = child(bytes, mp4a, 'esds', 28)!
    expect(esds).not.toBeNull()
    const esdsBody = bytes.subarray(esds.bodyStart, esds.end)
    // Full-box version/flags, then ES_Descriptor → DecoderConfig → ASC.
    expect(Array.from(esdsBody.subarray(0, 4))).toEqual([0, 0, 0, 0])
    expect(esdsBody[4]).toBe(0x03)
    expect(Array.from(esdsBody)).toContain(0x04)
    expect(containsSequence(esdsBody, audioDescription)).toBe(true)

    const mvhd = child(bytes, moov, 'mvhd')!
    expect(mvhd.end - mvhd.start).toBe(108)
    expect(readBoxUint32(bytes, mvhd, 16)).toBe(2200)

    let videoSamples = 0
    let audioSamples = 0
    for (const moof of top.filter((box) => box.type === 'moof')) {
      const traf = child(bytes, moof, 'traf')!
      const tfhd = child(bytes, traf, 'tfhd')!
      const trun = child(bytes, traf, 'trun')!
      const trackId = readBoxUint32(bytes, tfhd, 4)
      const sampleCount = readBoxUint32(bytes, trun, 4)
      if (trackId === 1) videoSamples += sampleCount
      else if (trackId === 2) audioSamples += sampleCount
    }
    expect(videoSamples).toBe(total)
    expect(audioSamples).toBe(audioTotal)
    expect(muxer.frameCount).toBe(total)
    expect(muxer.audioFrameCount).toBe(audioTotal)
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
