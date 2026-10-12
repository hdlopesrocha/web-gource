/**
 * Composite overlay for exported video.
 *
 * The on-screen panels are DOM, and a video frame can only come from a canvas,
 * so the export draws the same panel content into the frame with the shared
 * canvas routines from `render/overlays.ts`: the timeline histogram along the
 * bottom, the overview (minimap) in the bottom-right corner, and the activity
 * charts — commits per weekday and hour, plus the sliding contribution calendar
 * — in the right column.
 *
 * All geometry is derived from the frame size, so 720p, 1080p and portrait
 * exports all lay out sensibly, and nothing here touches the DOM.
 */

import type { Simulation } from '../../sim/simulation'
import type { ActivityBucket, TimelineAuthor, TimelineCommit } from '../../timeline/types'
import type { HudCommitInfo } from '../engine'
import { authorCssColor as authorColorCss } from '../../render/palette'
import { ActivityCursor, contributionCalendar, dayStartMs } from '../../timeline/activity'
import { MinimapDrawer } from '../../render/minimap'
import {
  drawActivityBars,
  drawContributionCalendar,
  drawPanel,
  drawWeekdayHour,
  SHADES,
  TEXT_COLOR,
  TEXT_STRONG,
} from '../../render/overlays'
import { formatDate, formatDateTime } from '../../timeline/schedule'
import { buildInfoPanelModel, drawInfoPanel } from '../../render/info-panel'

export interface OverlayFrame {
  /** Frame size in pixels. */
  width: number
  height: number
  /** Playback state. */
  simTime: number
  duration: number
  sim: Simulation
  cameraTarget: { x: number; y: number; z?: number }
  /** Interpolated real-world date at the current position (epoch ms). */
  date: number
  commit: TimelineCommit | null
  /** Commits per activity bucket, for the timeline histogram. */
  buckets: ActivityBucket[]
  /** Loaded-window statistics shown in the info panel. */
  timeline: { files: number; totalBytes: number; authors: number }
  /** Playback frame rate, shown in the info panel. */
  fps: number
}

/**
 * Font size for the chart axis labels.
 *
 * Scaled with the panel rather than the frame: the labels are the point of the
 * charts, and at 720p a fixed fraction of the frame made them unreadable.
 */
export function chartLabelSize(unit: number): number {
  return Math.max(9, Math.round(unit * 0.9))
}

export interface OverlayOptions {
  /** Draw the commit info panel. */
  info?: boolean
  /** Draw the overview (minimap). */
  overview?: boolean
  /** Draw the timeline histogram. */
  timeline?: boolean
  /** Draw the weekday × hour heatmap. */
  heatmap?: boolean
  /** Draw the contribution calendar. */
  contributions?: boolean
}

/**
 * Draws the export chrome. One instance per export: the overview keeps its
 * smoothing state between frames, exactly like the on-screen minimap.
 */
export class ExportOverlay {
  private minimap = new MinimapDrawer()
  private activity: ActivityCursor
  private authors: Map<string, { name: string; colorIndex: number }>

  constructor(
    commits: readonly TimelineCommit[],
    authors: readonly TimelineAuthor[] = [],
    private readonly options: OverlayOptions = {},
  ) {
    this.activity = new ActivityCursor(commits)
    this.authors = new Map(authors.map((author) => [author.id, { name: author.name, colorIndex: author.colorIndex }]))
  }

  /** Update the author lookup when the timeline changes. */
  setAuthors(authors: readonly TimelineAuthor[]): void {
    this.authors = new Map(authors.map((author) => [author.id, { name: author.name, colorIndex: author.colorIndex }]))
  }

  /** Update the aggregates after the timeline changes. */
  setCommits(commits: readonly TimelineCommit[]): void {
    this.activity.setCommits(commits)
    this.fileSizes = new Map()
  }

  /** Host-reported file sizes, used for the change rows in the info panel. */
  private fileSizes = new Map<string, number>()

  setFileSizes(sizes: Map<string, number>): void {
    this.fileSizes = sizes
  }

  /** The commit card's data, matching what the HUD shows on screen. */
  private commitInfo(commit: TimelineCommit): HudCommitInfo {
    const author = this.authorName(commit.authorId)
    return {
      sha: commit.sha,
      shortSha: commit.shortSha,
      subject: commit.subject,
      author: author.name,
      authorColor: author.color,
      isMerge: commit.isMerge,
      filesKnown: commit.filesKnown,
      filesMissingReason: commit.filesMissingReason,
      filesTruncated: commit.filesTruncated,
      changes: commit.changes.slice(0, 40).map((change) => {
        const size = this.fileSizes.get(change.path)
        return size === undefined
          ? { path: change.path, kind: change.kind }
          : { path: change.path, kind: change.kind, size }
      }),
      additions: commit.additions,
      deletions: commit.deletions,
      filesTotal: commit.filesTotal,
      timestamp: commit.timestamp,
    }
  }

  private authorName(authorId: string): { name: string; color: string } {
    const author = this.authors.get(authorId)
    if (!author) return { name: 'Unknown author', color: '#ffffff' }
    return { name: author.name, color: authorColorCss(author.colorIndex) }
  }

  draw(ctx: CanvasRenderingContext2D, frame: OverlayFrame): void {
    const { width, height } = frame
    const unit = Math.max(8, Math.round(Math.min(width, height) * 0.014))
    const font = `${unit}px "Inter", system-ui, sans-serif`
    const smallFont = `${chartLabelSize(unit)}px "Inter", system-ui, sans-serif`
    const titleFont = `600 ${Math.round(unit * 1.1)}px "Inter", system-ui, sans-serif`

    // Only what has happened by this frame: the charts grow as the video plays.
    this.activity.advanceTo(frame.date)
    const grid = this.activity.grid
    const daily = this.activity.daily

    ctx.save()
    ctx.textBaseline = 'middle'

    const padding = Math.round(unit * 0.9)
    const columnWidth = Math.round(Math.min(width * 0.3, Math.max(180, width * 0.26)))
    const timelineHeight = Math.round(Math.min(height * 0.12, Math.max(26, unit * 2.6)))
    const timelineY = height - timelineHeight - padding
    const overviewSize = Math.round(Math.min(columnWidth, Math.max(80, height * 0.24)))
    const overviewY = timelineY - overviewSize - padding

    // ---- timeline -------------------------------------------------------
    if (this.options.timeline !== false) {
      const barsHeight = Math.round(timelineHeight * 0.62)
      const labelHeight = timelineHeight - barsHeight
      drawPanel(ctx, padding, timelineY, width - padding * 2, timelineHeight, {
        background: 'rgba(9,13,24,0.68)',
      })

      ctx.font = font
      ctx.textAlign = 'left'
      ctx.fillStyle = TEXT_STRONG
      ctx.fillText(formatDateTime(frame.date), padding * 2, timelineY + labelHeight * 0.5)
      if (frame.commit) {
        const subject = frame.commit.subject
        const label = `${frame.commit.shortSha} · ${subject.length > 58 ? `${subject.slice(0, 57)}…` : subject}`
        ctx.fillStyle = TEXT_COLOR
        ctx.fillText(label, padding * 2 + unit * 11, timelineY + labelHeight * 0.5)
      }
      ctx.textAlign = 'right'
      ctx.fillStyle = TEXT_COLOR
      const percent = frame.duration > 0 ? Math.round((frame.simTime / frame.duration) * 100) : 0
      ctx.fillText(`${percent}%`, width - padding * 2, timelineY + labelHeight * 0.5)

      ctx.save()
      ctx.translate(padding * 2, timelineY + labelHeight)
      drawActivityBars(ctx, {
        width: width - padding * 4,
        height: barsHeight,
        buckets: frame.buckets,
        position: frame.simTime,
        duration: frame.duration,
      })
      ctx.restore()
    }

    // ---- overview -------------------------------------------------------
    if (this.options.overview !== false) {
      const x = width - padding - overviewSize
      drawPanel(ctx, x, overviewY, overviewSize, overviewSize, { radius: Math.round(unit * 0.6) })
      ctx.save()
      ctx.beginPath()
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x + 1, overviewY + 1, overviewSize - 2, overviewSize - 2, unit * 0.5)
      } else {
        ctx.rect(x + 1, overviewY + 1, overviewSize - 2, overviewSize - 2)
      }
      ctx.clip()
      // The drawer works in its own square, so move to the panel first.
      ctx.translate(x + 1, overviewY + 1)
      this.minimap.draw(ctx, {
        size: overviewSize - 2,
        sim: frame.sim,
        cameraTarget: frame.cameraTarget,
      })
      ctx.restore()
      ctx.font = font
      ctx.textAlign = 'left'
      ctx.fillStyle = TEXT_COLOR
      ctx.fillText('Overview', x + unit * 0.6, overviewY - unit * 0.7)
    }

    // ---- info panel (bottom-left, above the timeline) -------------------
    if (this.options.info !== false) {
      const infoWidth = columnWidth
      const infoHeight = Math.round(Math.min(height * 0.46, unit * 17))
      const infoY = Math.max(padding, timelineY - infoHeight - padding)
      const stats = frame.sim.stats()
      const activeAuthors = [...frame.sim.authors]
        .filter((author) => author.visible)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .slice(0, 4)
        .map((author) => ({
          id: author.author.id,
          name: author.author.name,
          color: authorColorCss(author.author.colorIndex),
          commits: author.appliedCommits,
        }))
      const model = buildInfoPanelModel({
        date: frame.date,
        time: frame.simTime,
        duration: frame.duration,
        fps: frame.fps,
        commit: frame.commit ? this.commitInfo(frame.commit) : null,
        visibleFiles: stats.visibleFiles,
        visibleDirs: stats.dirs,
        totalFiles: frame.timeline.files,
        totalBytes: frame.timeline.totalBytes,
        authors: frame.timeline.authors,
        activeAuthors: activeAuthors.map((author) => ({
          id: author.id,
          name: author.name,
          color: author.color,
          commits: author.commits,
          lastActiveAt: 0,
        })),
      })
      drawInfoPanel(ctx, model, {
        x: padding,
        y: infoY,
        width: infoWidth,
        height: infoHeight,
        unit,
        font,
        smallFont,
        monoFont: `${Math.max(7, Math.round(unit * 0.78))}px ui-monospace, "SFMono-Regular", Menlo, monospace`,
        panel: (x, y, width, height) => drawPanel(ctx, x, y, width, height, { radius: Math.round(unit * 0.6) }),
      })
    }

    // ---- activity column ------------------------------------------------
    const columnX = width - padding - columnWidth
    let cursorY = padding

    if (this.options.heatmap !== false) {
      const chartHeight = Math.round(columnWidth * 0.46)
      const panelHeight = chartHeight + unit * 3
      drawPanel(ctx, columnX, cursorY, columnWidth, panelHeight, { radius: Math.round(unit * 0.6) })
      ctx.font = titleFont
      ctx.textAlign = 'left'
      ctx.fillStyle = TEXT_STRONG
      ctx.fillText('Commits per weekday and hour', columnX + unit * 0.8, cursorY + unit * 1.2)
      ctx.save()
      ctx.translate(columnX + unit * 0.8, cursorY + unit * 1.8)
      drawWeekdayHour(ctx, {
        width: columnWidth - unit * 1.6,
        height: chartHeight,
        grid,
        font: smallFont,
      })
      ctx.restore()
      cursorY += panelHeight + padding
    }

    if (this.options.contributions !== false) {
      const chartHeight = Math.round(columnWidth * 0.42)
      const panelHeight = chartHeight + unit * 5.2
      const calendar = contributionCalendar(daily, frame.date)
      drawPanel(ctx, columnX, cursorY, columnWidth, panelHeight, { radius: Math.round(unit * 0.6) })
      ctx.font = titleFont
      ctx.textAlign = 'left'
      ctx.fillStyle = TEXT_STRONG
      ctx.fillText('Contributions · last 53 weeks', columnX + unit * 0.8, cursorY + unit * 1.2)
      ctx.fillStyle = TEXT_COLOR
      ctx.fillText(
        `${calendar.total.toLocaleString()} commits · ${formatDate(dayStartMs(calendar.start))} → ${formatDate(dayStartMs(calendar.end))}`,
        columnX + unit * 0.8,
        cursorY + unit * 2.4,
      )
      ctx.save()
      ctx.translate(columnX + unit * 0.8, cursorY + unit * 3.2)
      drawContributionCalendar(ctx, {
        width: columnWidth - unit * 1.6,
        height: chartHeight,
        calendar,
        font: smallFont,
      })
      ctx.restore()

      // Less / More legend, like the on-screen panel.
      let legendX = columnX + unit * 0.8
      const legendY = cursorY + unit * 3.2 + chartHeight + unit * 0.9
      ctx.font = smallFont
      ctx.fillStyle = TEXT_COLOR
      ctx.textAlign = 'left'
      ctx.fillText('Less', legendX, legendY)
      legendX += ctx.measureText('Less').width + unit * 0.5
      for (const shade of SHADES) {
        ctx.fillStyle = shade
        ctx.fillRect(legendX, legendY - unit * 0.55, unit * 0.9, unit * 0.9)
        legendX += unit * 1.2
      }
      ctx.fillStyle = TEXT_COLOR
      ctx.fillText('More', legendX, legendY)
    }

    ctx.restore()
  }
}
