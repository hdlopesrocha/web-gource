/**
 * Gamepad → camera control mapping.
 *
 * The pad drives a free 6-DOF camera: the sticks rotate it (as quaternion
 * deltas around the camera's own axes, so roll is possible and there is no
 * gimbal lock) and the D-pad plus the right stick translate it along the
 * camera's forward, side and up directions.
 *
 * Mapping (standard layout):
 *
 *   left stick X / Y     yaw / pitch
 *   right stick X / Y    roll / thrust (forward, back)
 *   D-pad X / Y          strafe (side), rise / sink (up)
 *   RT / LT              forward / back thrust (analog, added to the stick)
 *   A (button 0)         recalibrate the head tracking
 *
 * Everything here is a pure function of the pad state, so the mapping can be
 * tested without a browser.
 */
export interface GamepadOptions {
  /** Stick deflection below this reads as zero (0…1). */
  deadZone: number
  /** Radians per second of rotation at full deflection. */
  rotateSpeed: number
  /** World units per second of translation at full deflection. */
  moveSpeed: number
}

export const DEFAULT_GAMEPAD_OPTIONS: GamepadOptions = {
  deadZone: 0.16,
  // About 86°/s of rotation and half the tree per second at full deflection:
  // fast enough to feel direct, slow enough to aim. The settings slider scales
  // both from 0.2× to 3×.
  rotateSpeed: 1.5,
  moveSpeed: 45,
}

/** Buttons we care about in the standard mapping. */
export const GAMEPAD_BUTTON = {
  recalibrate: 0,
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
  leftTrigger: 6,
  rightTrigger: 7,
} as const

/** The frame's control state, in camera-local terms. */
export interface GamepadState {
  connected: boolean
  id: string | null
  /** Rotation around the camera's own up / right / forward axes, in rad/s. */
  yaw: number
  pitch: number
  roll: number
  /** Translation along the camera's forward / side / up axes, in world units/s. */
  forward: number
  side: number
  up: number
  /** True only on the frame the recalibrate button goes down. */
  calibrate: boolean
}

/** The bits of the browser's `Gamepad` we read (so tests can pass objects). */
export interface GamepadLike {
  id?: string
  axes: readonly number[]
  buttons: readonly { pressed: boolean; value?: number }[]
}

/** A disconnected/idle state, shared so the common case allocates nothing. */
const IDLE: GamepadState = {
  connected: false,
  id: null,
  yaw: 0,
  pitch: 0,
  roll: 0,
  forward: 0,
  side: 0,
  up: 0,
  calibrate: false,
}

/** Dead-zone one stick axis and square the remainder, so small pushes are fine. */
export function stickAxis(value: number, deadZone: number): number {
  if (!Number.isFinite(value)) return 0
  const magnitude = Math.abs(value)
  const zone = Math.min(0.9, Math.max(0, deadZone))
  if (magnitude <= zone) return 0
  const scaled = (magnitude - zone) / (1 - zone)
  return Math.sign(value) * scaled * scaled
}

/** A button that exists and is pressed. */
function pressed(pad: GamepadLike, index: number): boolean {
  return pad.buttons[index]?.pressed === true
}

/** An analog value (triggers), 0 when the pad has no such button. */
function analog(pad: GamepadLike, index: number): number {
  const button = pad.buttons[index]
  if (!button) return 0
  if (typeof button.value === 'number' && Number.isFinite(button.value)) return button.value
  return button.pressed ? 1 : 0
}

/**
 * Read one pad into a control state.
 *
 * `held` carries the recalibrate button's state from the previous frame, so the
 * action fires once per press instead of every frame.
 */
export function readGamepad(
  pad: GamepadLike,
  options: GamepadOptions = DEFAULT_GAMEPAD_OPTIONS,
  held: { calibrate?: boolean } = {},
): GamepadState {
  const zone = options.deadZone
  const leftX = stickAxis(pad.axes[0] ?? 0, zone)
  const leftY = stickAxis(pad.axes[1] ?? 0, zone)
  const rightX = stickAxis(pad.axes[2] ?? 0, zone)
  const rightY = stickAxis(pad.axes[3] ?? 0, zone)

  const strafe = (pressed(pad, GAMEPAD_BUTTON.dpadRight) ? 1 : 0) - (pressed(pad, GAMEPAD_BUTTON.dpadLeft) ? 1 : 0)
  const rise = (pressed(pad, GAMEPAD_BUTTON.dpadUp) ? 1 : 0) - (pressed(pad, GAMEPAD_BUTTON.dpadDown) ? 1 : 0)
  const triggerThrust = analog(pad, GAMEPAD_BUTTON.rightTrigger) - analog(pad, GAMEPAD_BUTTON.leftTrigger)

  const calibratePressed = pressed(pad, GAMEPAD_BUTTON.recalibrate)
  const calibrate = calibratePressed && held.calibrate !== true

  return {
    connected: true,
    id: pad.id ?? null,
    // Pushing the left stick right turns the view right, pushing it away tilts
    // the view up.
    yaw: zeroSafe(-leftX * options.rotateSpeed),
    pitch: zeroSafe(-leftY * options.rotateSpeed),
    // Right stick: lean to roll, push away to fly forward.
    roll: zeroSafe(-rightX * options.rotateSpeed),
    forward: zeroSafe((-rightY + triggerThrust) * options.moveSpeed),
    side: zeroSafe(strafe * options.moveSpeed),
    up: zeroSafe(rise * options.moveSpeed),
    calibrate,
  }
}

/** Keep `-0` out of the state, so "no input" is exactly zero. */
function zeroSafe(value: number): number {
  return value === 0 ? 0 : value
}

/** Snapshot of a control state (tests and callers may want to keep it). */
export function cloneState(state: GamepadState): GamepadState {
  return { ...state }
}

/**
 * Polls the browser for a pad and maps it to control state.
 *
 * The controller owns no camera: it turns device state into numbers, and the
 * caller decides what to do with them.
 */
export class GamepadController {
  private options: GamepadOptions
  private heldCalibrate = false
  private lastState: GamepadState = { ...IDLE }

  constructor(options: Partial<GamepadOptions> = {}) {
    this.options = { ...DEFAULT_GAMEPAD_OPTIONS, ...options }
  }

  setOptions(options: Partial<GamepadOptions>): void {
    this.options = { ...this.options, ...options }
  }

  get connected(): boolean {
    return this.lastState.connected
  }

  /** The pad the browser currently reports, or null. */
  private activePad(): GamepadLike | null {
    const pads = typeof navigator !== 'undefined' ? navigator.getGamepads?.() : null
    if (!pads) return null
    for (const pad of pads) {
      if (pad && pad.connected !== false && pad.axes && pad.axes.length > 0) return pad
    }
    return null
  }

  /** Read the device and return this frame's control state. */
  poll(): GamepadState {
    const pad = this.activePad()
    if (!pad) {
      this.heldCalibrate = false
      this.lastState = { ...IDLE }
      return this.lastState
    }
    const state = readGamepad(pad, this.options, { calibrate: this.heldCalibrate })
    this.heldCalibrate = pressed(pad, GAMEPAD_BUTTON.recalibrate)
    this.lastState = state
    return state
  }
}
