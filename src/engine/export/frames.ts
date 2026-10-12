/**
 * Frame plan for a deterministic animation export.
 *
 * The export renders exactly {@link EXPORT_FPS} frames per *simulated* second,
 * independent of how long the machine takes, so the result is identical on fast
 * and slow hardware. Frame `i` always represents simulated time `i / fps`; the
 * last frame lands exactly on the animation's end.
 */

export const EXPORT_FPS = 30

export interface FramePlan {
  fps: number
  /** Number of frames to render, including the final one at `duration`. */
  totalFrames: number
  /** Simulated duration of the animation in seconds. */
  duration: number
}

/**
 * Frames for an animation of `duration` simulated seconds.
 *
 * The end time is inclusive: a 4 s animation produces 121 frames (t = 0 … 4 s),
 * so the very last commit is always in the video even when it lands on the end.
 */
export function planFrames(duration: number, fps: number = EXPORT_FPS): FramePlan {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : EXPORT_FPS
  const totalFrames = safeDuration <= 0 ? 1 : Math.max(1, Math.floor(safeDuration * safeFps) + 1)
  return { fps: safeFps, totalFrames, duration: safeDuration }
}

/** Simulated time of a frame, clamped to the animation's end. */
export function timeForFrame(plan: FramePlan, frame: number): number {
  const clamped = Math.max(0, Math.min(plan.totalFrames - 1, Math.floor(frame)))
  return Math.min(plan.duration, clamped / plan.fps)
}

/** Presentation timestamp of a frame in microseconds (exact, no drift). */
export function timestampForFrame(plan: FramePlan, frame: number): number {
  return Math.round((Math.max(0, Math.floor(frame)) * 1_000_000) / plan.fps)
}

/** Frame duration in microseconds, derived from the timestamps to avoid drift. */
export function durationForFrame(plan: FramePlan, frame: number): number {
  const start = timestampForFrame(plan, frame)
  const next = frame + 1 < plan.totalFrames ? timestampForFrame(plan, frame + 1) : start + Math.round(1_000_000 / plan.fps)
  return Math.max(1, next - start)
}

/** How many frames pass between keyframes: one per simulated second. */
export function keyFrameInterval(plan: FramePlan): number {
  return Math.max(1, Math.round(plan.fps))
}

/** True when this frame should be encoded as a keyframe (frame 0 always is). */
export function isKeyFrame(plan: FramePlan, frame: number): boolean {
  const interval = keyFrameInterval(plan)
  return frame === 0 || frame % interval === 0
}

/** Progress helpers shared by the exporter and the UI. */
export function framePercent(plan: FramePlan, framesRendered: number): number {
  if (plan.totalFrames <= 0) return 0
  return Math.max(0, Math.min(100, (framesRendered / plan.totalFrames) * 100))
}
