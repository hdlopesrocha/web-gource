/**
 * The info panel: the commit card shown bottom-left on screen and inside an
 * exported video.
 *
 * The *content* lives here as a plain model, built from the same inputs the HUD
 * uses, so the Vue panel and the canvas renderer cannot drift apart. The canvas
 * side draws the model; the DOM side renders it as markup.
 */

import { formatBytes } from '../util/format'
import { formatDateTime, formatDuration } from '../timeline/schedule'
import type { HudAuthor, HudCommitInfo } from '../engine/engine'

export interface InfoPanelInput {
  /** Interpolated real-world date at the playback position (epoch ms). */
  date: number
  /** Simulated seconds played and the animation's duration. */
  time: number
  duration: number
  fps: number
  commit: HudCommitInfo | null
  visibleFiles: number
  visibleDirs: number
  /** Files in the loaded window, total tracked bytes and author count. */
  totalFiles: number
  totalBytes: number
  authors: number
  activeAuthors: readonly HudAuthor[]
}

export interface InfoPanelChange {
  kind: string
  /** Human label: added / modified / deleted / renamed. */
  label: string
  path: string
  size?: number
}

export interface InfoPanelModel {
  dateLabel: string
  timeLabel: string
  fpsLabel: string
  isMerge: boolean
  subject: string
  author: { name: string; color: string; shortSha: string; additions: number; deletions: number } | null
  /** Up to {@link MAX_CHANGES} files, the way the panel shows them. */
  changes: InfoPanelChange[]
  /** Files beyond the shown ones, and whether the host truncated the list. */
  moreFiles: number
  truncated: boolean
  /** Set when the commit has no file data, explaining why. */
  missing: string | null
  stats: { value: string; label: string }[]
  workingNow: { id: string; name: string; color: string; commits: number }[]
}

/** Files listed in the panel before it says "+N more". */
export const MAX_CHANGES = 9
/** Authors listed under "working now". */
export const MAX_WORKING_NOW = 4

const CHANGE_KIND_LABEL: Record<string, string> = {
  add: 'added',
  modify: 'modified',
  delete: 'deleted',
  rename: 'renamed',
}

export function missingFilesLabel(reason: string | undefined): string {
  switch (reason) {
    case 'rate-limit':
      return 'File list unavailable: API quota exhausted'
    case 'merge-parents':
      return 'Merge commit: the host reported no changed files'
    case 'too-large':
      return 'File list unavailable: commit too large'
    case 'error':
      return 'File list unavailable: request failed'
    default:
      return 'File list unavailable'
  }
}

/** Build the panel's content from the current playback state. */
export function buildInfoPanelModel(input: InfoPanelInput): InfoPanelModel {
  const commit = input.commit
  const changes: InfoPanelChange[] = (commit?.changes ?? []).slice(0, MAX_CHANGES).map((change) => ({
    kind: change.kind,
    label: CHANGE_KIND_LABEL[change.kind] ?? change.kind,
    path: change.path,
    size: change.size,
  }))

  return {
    dateLabel: input.date > 0 ? formatDateTime(input.date) : '—',
    timeLabel: `${formatDuration(input.time)} / ${formatDuration(input.duration)}`,
    fpsLabel: `${input.fps} fps`,
    isMerge: Boolean(commit?.isMerge),
    subject: commit?.subject ?? '—',
    author: commit
      ? {
          name: commit.author,
          color: commit.authorColor,
          shortSha: commit.shortSha,
          additions: commit.additions,
          deletions: commit.deletions,
        }
      : null,
    changes,
    moreFiles: Math.max(0, (commit?.changes.length ?? 0) - MAX_CHANGES),
    truncated: Boolean(commit?.filesTruncated),
    missing: commit && !commit.filesKnown ? missingFilesLabel(commit.filesMissingReason) : null,
    stats: [
      { value: String(input.visibleFiles), label: 'files in tree' },
      { value: String(input.visibleDirs), label: 'directories' },
      { value: input.totalFiles.toLocaleString(), label: 'files in history' },
      { value: formatBytes(input.totalBytes), label: 'tracked size' },
      { value: String(input.authors), label: 'authors' },
    ],
    workingNow: input.activeAuthors.slice(0, MAX_WORKING_NOW).map((author) => ({
      id: author.id,
      name: author.name,
      color: author.color,
      commits: author.commits,
    })),
  }
}

/* ------------------------------------------------------------------ *
 * Canvas rendering (used by the video compositor)
 * ------------------------------------------------------------------ */

export interface InfoPanelDrawOptions {
  x: number
  y: number
  width: number
  height: number
  /** Base font size in pixels. */
  unit: number
  font: string
  smallFont: string
  monoFont: string
  /** Rounded panel chrome. */
  panel: (x: number, y: number, width: number, height: number) => void
}

/** Truncate text with an ellipsis so it fits the given width. */
export function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (ctx.measureText(text).width <= maxWidth) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = `${text.slice(0, middle)}…`
    if (ctx.measureText(candidate).width <= maxWidth) low = middle
    else high = middle - 1
  }
  return low <= 0 ? '' : `${text.slice(0, low)}…`
}

/**
 * Draw the panel: date and progress, the commit subject and author, the files
 * it changed, the tree statistics and who is working right now.
 */
export function drawInfoPanel(
  ctx: CanvasRenderingContext2D,
  model: InfoPanelModel,
  options: InfoPanelDrawOptions,
): void {
  const { x, y, width, height, unit } = options
  const padding = Math.round(unit * 0.9)
  const inner = width - padding * 2
  options.panel(x, y, width, height)

  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, width, height)
  ctx.clip()
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'

  let cursor = y + padding

  // ---- date and progress ------------------------------------------------
  ctx.font = `600 ${Math.round(unit * 1.5)}px "Inter", system-ui, sans-serif`
  ctx.fillStyle = 'rgba(230,244,255,0.95)'
  ctx.fillText(fitText(ctx, model.dateLabel, inner), x + padding, cursor + unit * 0.75)
  ctx.font = options.monoFont
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  const progress = `${model.timeLabel} · ${model.fpsLabel}`
  ctx.textAlign = 'right'
  ctx.fillText(progress, x + width - padding, cursor + unit * 0.75)
  if (model.isMerge) {
    ctx.fillStyle = 'rgba(255,200,120,0.9)'
    ctx.fillText('merge', x + width - padding, cursor + unit * 2.1)
  }
  ctx.textAlign = 'left'
  cursor += unit * 2.2

  // ---- commit subject ---------------------------------------------------
  ctx.font = options.font
  ctx.fillStyle = 'rgba(255,255,255,0.9)'
  const subject = model.subject
  const subjectLines = wrapText(ctx, subject, inner, 2)
  for (const line of subjectLines) {
    ctx.fillText(line, x + padding, cursor)
    cursor += unit * 1.25
  }
  cursor += unit * 0.15

  // ---- author -----------------------------------------------------------
  if (model.author) {
    const author = model.author
    ctx.beginPath()
    ctx.arc(x + padding + unit * 0.35, cursor, unit * 0.35, 0, Math.PI * 2)
    ctx.fillStyle = author.color
    ctx.fill()
    let authorX = x + padding + unit * 1.1
    ctx.font = options.font
    ctx.fillStyle = 'rgba(214,230,255,0.95)'
    const name = fitText(ctx, author.name, inner * 0.35)
    ctx.fillText(name, authorX, cursor)
    authorX += ctx.measureText(name).width + unit * 0.8
    ctx.font = options.monoFont
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.fillText(author.shortSha, authorX, cursor)
    ctx.textAlign = 'right'
    ctx.fillText(`+${author.additions} / −${author.deletions}`, x + width - padding, cursor)
    ctx.textAlign = 'left'
    cursor += unit * 1.5
  }

  // ---- changed files ----------------------------------------------------
  if (model.changes.length > 0) {
    for (const change of model.changes) {
      ctx.font = options.font
      const label = change.label
      const labelWidth = ctx.measureText(label).width + unit * 0.9
      // Kind chip.
      ctx.fillStyle = change.kind === 'delete' ? 'rgba(255,93,108,0.22)' : change.kind === 'add' ? 'rgba(84,255,159,0.2)' : 'rgba(255,200,87,0.2)'
      ctx.fillRect(x + padding, cursor - unit * 0.65, labelWidth, unit * 1.3)
      ctx.fillStyle = change.kind === 'delete' ? 'rgba(255,150,160,0.95)' : change.kind === 'add' ? 'rgba(140,255,190,0.95)' : 'rgba(255,215,140,0.95)'
      ctx.fillText(label, x + padding + unit * 0.45, cursor)

      ctx.font = options.monoFont
      const sizeLabel = change.size !== undefined ? formatBytes(change.size) : ''
      const sizeWidth = sizeLabel ? ctx.measureText(sizeLabel).width + unit * 0.8 : 0
      ctx.fillStyle = 'rgba(255,255,255,0.55)'
      const pathWidth = inner - labelWidth - sizeWidth - unit * 0.8
      ctx.fillText(fitText(ctx, change.path, Math.max(20, pathWidth)), x + padding + labelWidth + unit * 0.6, cursor)
      if (sizeLabel) {
        ctx.textAlign = 'right'
        ctx.fillStyle = 'rgba(255,255,255,0.45)'
        ctx.fillText(sizeLabel, x + width - padding, cursor)
        ctx.textAlign = 'left'
      }
      cursor += unit * 1.35
    }
    if (model.moreFiles > 0) {
      ctx.font = options.font
      ctx.fillStyle = 'rgba(255,255,255,0.45)'
      ctx.fillText(`+${model.moreFiles} more files in this commit`, x + padding, cursor)
      cursor += unit * 1.3
    }
    if (model.truncated) {
      ctx.font = options.font
      ctx.fillStyle = 'rgba(255,255,255,0.45)'
      ctx.fillText("The host truncated this commit's file list at 300 entries.", x + padding, cursor)
      cursor += unit * 1.3
    }
  } else if (model.missing) {
    ctx.font = options.font
    ctx.fillStyle = 'rgba(255,200,120,0.9)'
    ctx.fillText('no file data', x + padding, cursor)
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.fillText(fitText(ctx, model.missing, inner * 0.7), x + padding + unit * 6, cursor)
    cursor += unit * 1.3
  }

  // ---- tree statistics --------------------------------------------------
  cursor = Math.min(cursor + unit * 0.4, y + height - padding - unit * 4)
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x + padding, cursor)
  ctx.lineTo(x + width - padding, cursor)
  ctx.stroke()
  cursor += unit * 1.1

  const columns = Math.min(3, model.stats.length)
  const columnWidth = inner / columns
  for (let index = 0; index < model.stats.length; index += 1) {
    const column = index % columns
    const row = Math.floor(index / columns)
    const statX = x + padding + column * columnWidth
    const statY = cursor + row * unit * 2.4
    ctx.font = `600 ${Math.round(unit * 1.25)}px "Inter", system-ui, sans-serif`
    ctx.fillStyle = 'rgba(220,236,255,0.95)'
    ctx.fillText(fitText(ctx, model.stats[index].value, columnWidth - unit), statX, statY)
    ctx.font = options.smallFont
    ctx.fillStyle = 'rgba(255,255,255,0.42)'
    ctx.fillText(model.stats[index].label.toUpperCase(), statX, statY + unit * 1.05)
  }
  cursor += unit * 2.4 * Math.ceil(model.stats.length / columns)

  // ---- working now ------------------------------------------------------
  if (model.workingNow.length > 0) {
    ctx.font = options.smallFont
    ctx.fillStyle = 'rgba(255,255,255,0.42)'
    ctx.fillText('WORKING NOW', x + padding, cursor)
    cursor += unit * 1.2
    let chipX = x + padding
    for (const author of model.workingNow) {
      ctx.font = options.font
      const label = author.name
      const chipWidth = ctx.measureText(label).width + unit * 3.4
      if (chipX + chipWidth > x + width - padding) break
      ctx.fillStyle = 'rgba(255,255,255,0.06)'
      ctx.fillRect(chipX, cursor - unit * 0.7, chipWidth, unit * 1.5)
      ctx.beginPath()
      ctx.arc(chipX + unit * 0.7, cursor, unit * 0.32, 0, Math.PI * 2)
      ctx.fillStyle = author.color
      ctx.fill()
      ctx.fillStyle = 'rgba(255,255,255,0.75)'
      ctx.fillText(label, chipX + unit * 1.3, cursor)
      ctx.font = options.smallFont
      ctx.fillStyle = 'rgba(255,255,255,0.45)'
      ctx.fillText(String(author.commits), chipX + chipWidth - unit * 1.4, cursor)
      chipX += chipWidth + unit * 0.6
    }
  }

  ctx.restore()
}

/** Wrap text into at most `maxLines` lines, ellipsising the last one. */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate
      continue
    }
    if (current) lines.push(current)
    current = word
    if (lines.length === maxLines) break
  }
  if (lines.length < maxLines && current) lines.push(current)
  if (lines.length === 0) return []
  if (lines.length === maxLines) {
    // Ellipsise the last line when there is more text left over.
    const used = lines.join(' ').length
    if (used < text.replace(/\s+/g, ' ').trim().length) {
      lines[lines.length - 1] = fitText(ctx, `${lines[lines.length - 1]} …`, maxWidth)
    }
  }
  return lines.map((line) => fitText(ctx, line, maxWidth))
}
