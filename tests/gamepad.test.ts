import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_GAMEPAD_OPTIONS,
  GAMEPAD_BUTTON,
  GamepadController,
  readGamepad,
  stickAxis,
  type GamepadLike,
} from '../src/render/gamepad'

/** A pad with neutral sticks and no buttons pressed. */
function pad(overrides: { axes?: number[]; buttons?: Record<number, boolean | number> } = {}): GamepadLike {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }))
  for (const [index, value] of Object.entries(overrides.buttons ?? {})) {
    const at = Number(index)
    buttons[at] = typeof value === 'number' ? { pressed: value > 0, value } : { pressed: value, value: value ? 1 : 0 }
  }
  return { id: 'Test Pad', axes: overrides.axes ?? [0, 0, 0, 0], buttons }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('gamepad stick response', () => {
  it('ignores deflection inside the dead zone and squares what is left', () => {
    expect(stickAxis(0, 0.16)).toBe(0)
    expect(stickAxis(0.1, 0.16)).toBe(0)
    expect(stickAxis(-0.16, 0.16)).toBe(0)
    // (0.58 - 0.16) / (1 - 0.16) = 0.5, squared = 0.25: fine control near centre.
    expect(stickAxis(0.58, 0.16)).toBeCloseTo(0.25, 6)
    expect(stickAxis(-0.58, 0.16)).toBeCloseTo(-0.25, 6)
    expect(stickAxis(1, 0.16)).toBeCloseTo(1, 6)
    expect(stickAxis(Number.NaN, 0.16)).toBe(0)
  })
})

describe('gamepad mapping', () => {
  it('maps the left stick to yaw and pitch', () => {
    const right = readGamepad(pad({ axes: [1, 0, 0, 0] }))
    // Pushing the stick right turns the view right (negative yaw around the up).
    expect(right.yaw).toBeCloseTo(-DEFAULT_GAMEPAD_OPTIONS.rotateSpeed, 6)
    expect(right.pitch).toBe(0)

    const up = readGamepad(pad({ axes: [0, -1, 0, 0] }))
    // Pushing it away tilts the view up.
    expect(up.pitch).toBeCloseTo(DEFAULT_GAMEPAD_OPTIONS.rotateSpeed, 6)
    expect(up.yaw).toBe(0)
  })

  it('maps the right stick to roll and thrust', () => {
    const roll = readGamepad(pad({ axes: [0, 0, 1, 0] }))
    expect(roll.roll).toBeCloseTo(-DEFAULT_GAMEPAD_OPTIONS.rotateSpeed, 6)
    expect(roll.forward).toBe(0)

    const forward = readGamepad(pad({ axes: [0, 0, 0, -1] }))
    expect(forward.forward).toBeCloseTo(DEFAULT_GAMEPAD_OPTIONS.moveSpeed, 6)
    const back = readGamepad(pad({ axes: [0, 0, 0, 1] }))
    expect(back.forward).toBeCloseTo(-DEFAULT_GAMEPAD_OPTIONS.moveSpeed, 6)
  })

  it('maps the D-pad to strafing and rising', () => {
    const right = readGamepad(pad({ buttons: { [GAMEPAD_BUTTON.dpadRight]: true } }))
    expect(right.side).toBeCloseTo(DEFAULT_GAMEPAD_OPTIONS.moveSpeed, 6)
    const left = readGamepad(pad({ buttons: { [GAMEPAD_BUTTON.dpadLeft]: true } }))
    expect(left.side).toBeCloseTo(-DEFAULT_GAMEPAD_OPTIONS.moveSpeed, 6)
    const up = readGamepad(pad({ buttons: { [GAMEPAD_BUTTON.dpadUp]: true } }))
    expect(up.up).toBeCloseTo(DEFAULT_GAMEPAD_OPTIONS.moveSpeed, 6)
    const down = readGamepad(pad({ buttons: { [GAMEPAD_BUTTON.dpadDown]: true } }))
    expect(down.up).toBeCloseTo(-DEFAULT_GAMEPAD_OPTIONS.moveSpeed, 6)
  })

  it('adds the analog triggers to the thrust', () => {
    const forward = readGamepad(pad({ buttons: { [GAMEPAD_BUTTON.rightTrigger]: 0.5 } }))
    expect(forward.forward).toBeCloseTo(0.5 * DEFAULT_GAMEPAD_OPTIONS.moveSpeed, 6)
    const both = readGamepad(
      pad({ buttons: { [GAMEPAD_BUTTON.rightTrigger]: 1, [GAMEPAD_BUTTON.leftTrigger]: 1 } }),
    )
    expect(both.forward).toBeCloseTo(0, 6)
  })

  it('fires the recalibrate action once per press', () => {
    const held = { calibrate: false }
    const first = readGamepad(pad({ buttons: { [GAMEPAD_BUTTON.recalibrate]: true } }), DEFAULT_GAMEPAD_OPTIONS, held)
    expect(first.calibrate).toBe(true)
    // While the button stays down the action does not repeat.
    const again = readGamepad(pad({ buttons: { [GAMEPAD_BUTTON.recalibrate]: true } }), DEFAULT_GAMEPAD_OPTIONS, {
      calibrate: true,
    })
    expect(again.calibrate).toBe(false)
    const released = readGamepad(pad(), DEFAULT_GAMEPAD_OPTIONS, { calibrate: true })
    expect(released.calibrate).toBe(false)
  })
})

describe('gamepad controller', () => {
  it('reports no pad when the browser has none', () => {
    vi.stubGlobal('navigator', { getGamepads: () => [null] })
    const controller = new GamepadController()
    const state = controller.poll()
    expect(state.connected).toBe(false)
    expect(controller.connected).toBe(false)
    expect(state.yaw).toBe(0)
  })

  it('reads the first connected pad and follows its options', () => {
    vi.stubGlobal('navigator', { getGamepads: () => [pad({ axes: [1, 0, 0, 0] })] })
    const controller = new GamepadController({ rotateSpeed: 1, moveSpeed: 10 })
    const state = controller.poll()
    expect(state.connected).toBe(true)
    expect(state.id).toBe('Test Pad')
    expect(state.yaw).toBeCloseTo(-1, 6)
    expect(controller.connected).toBe(true)

    controller.setOptions({ rotateSpeed: 2 })
    expect(controller.poll().yaw).toBeCloseTo(-2, 6)
  })

  it('survives a browser without the Gamepad API', () => {
    vi.stubGlobal('navigator', {})
    const controller = new GamepadController()
    expect(controller.poll().connected).toBe(false)
  })
})
