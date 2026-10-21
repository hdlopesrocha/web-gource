/**
 * Playback rates offered by every speed control (the on-screen selector, the
 * keyboard shortcuts and the in-VR speed button). Keeping one ordered list
 * makes the VR button cycle exactly as the other controls do.
 */
export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16, 32] as const

/**
 * The next preset rate above `speed`, wrapping back to the slowest after the
 * fastest. A rate that is not a preset (for example one restored from an old
 * session) advances to the next preset above it.
 */
export function nextPlaybackSpeed(speed: number): number {
  const next = PLAYBACK_SPEEDS.find((value) => value > speed + 0.001)
  return next ?? PLAYBACK_SPEEDS[0]
}
