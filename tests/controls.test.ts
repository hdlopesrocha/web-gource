import { afterEach, describe, expect, it, vi } from 'vitest'
import { CameraControls } from '../src/engine/controls'
import { OrbitCamera } from '../src/render/camera'
import { GamepadController, type GamepadLike } from '../src/render/gamepad'
import { DeviceOrientationController } from '../src/render/orientation'
import { store } from '../src/state/store'

const BOUNDS = { center: { x: 0, y: 0, z: 0 }, radius: 40 }

/** A pad with neutral sticks and no buttons pressed. */
function pad(overrides: { axes?: number[]; buttons?: Record<number, boolean> } = {}): GamepadLike {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }))
  for (const [index, value] of Object.entries(overrides.buttons ?? {})) {
    buttons[Number(index)] = { pressed: value, value: value ? 1 : 0 }
  }
  return { id: 'Test Pad', axes: overrides.axes ?? [0, 0, 0, 0], buttons }
}

function rig(): OrbitCamera {
  const camera = new OrbitCamera()
  camera.frame(BOUNDS, true)
  return camera
}

afterEach(() => {
  vi.unstubAllGlobals()
  store.ui.gamepadConnected = false
  store.ui.gyroActive = false
})

describe('CameraControls', () => {
  it('does nothing until a device is enabled and reporting', () => {
    vi.stubGlobal('navigator', { getGamepads: () => [pad({ axes: [1, 1, 0, 0] })] })
    const controls = new CameraControls()
    const camera = rig()
    controls.update(1 / 60, camera, {})
    expect(camera.isFree).toBe(false)
    // The status still reflects the hardware, so the UI can offer the toggle.
    expect(store.ui.gamepadConnected).toBe(true)
    controls.dispose()
    camera.dispose()
  })

  it('flies the camera with the gamepad and hands it back when disabled', () => {
    vi.stubGlobal('navigator', { getGamepads: () => [pad({ axes: [1, 0, 0, -1] })] })
    const controls = new CameraControls()
    const camera = rig()
    const before = camera.camera.quaternion.clone()

    controls.update(0.5, camera, { gamepad: true })
    expect(camera.isFree).toBe(true)
    // The stick turned the view and pushed it forward along its own direction.
    expect(camera.camera.quaternion.angleTo(before)).toBeGreaterThan(0.1)

    controls.update(0.5, camera, {})
    expect(camera.isFree).toBe(false)
    controls.dispose()
    camera.dispose()
  })

  it('scales the gamepad response with the sensitivity setting', () => {
    vi.stubGlobal('navigator', { getGamepads: () => [pad({ axes: [1, 0, 0, 0] })] })
    const controls = new CameraControls()
    const slow = rig()
    const fast = rig()
    const start = slow.camera.quaternion.clone()

    controls.update(0.5, slow, { gamepad: true, gamepadSensitivity: 0.5 })
    controls.update(0.5, fast, { gamepad: true, gamepadSensitivity: 2 })
    const slowTurn = start.angleTo(slow.camera.quaternion)
    const fastTurn = start.angleTo(fast.camera.quaternion)
    expect(fastTurn).toBeGreaterThan(slowTurn * 2)

    controls.dispose()
    slow.dispose()
    fast.dispose()
  })

  it('follows the gyroscope and reports it as active', () => {
    const orientation = new DeviceOrientationController()
    orientation.setScreenAngle(0)
    orientation.push({ alpha: 0, beta: 0, gamma: 0 })
    const controls = new CameraControls({ orientation })
    const camera = rig()

    controls.update(1 / 60, camera, { gyro: true })
    expect(camera.isFree).toBe(true)
    expect(store.ui.gyroActive).toBe(true)

    // Calibrating does not move the view; the next pose is measured from it.
    const calibrated = camera.camera.quaternion.clone()
    controls.recalibrate(camera)
    expect(camera.camera.quaternion.angleTo(calibrated)).toBeCloseTo(0, 6)

    orientation.push({ alpha: 90, beta: 0, gamma: 0 })
    controls.update(1 / 60, camera, { gyro: true })
    expect(camera.camera.quaternion.angleTo(calibrated)).toBeCloseTo(Math.PI / 2, 3)

    controls.update(1 / 60, camera, { gyro: false })
    expect(camera.isFree).toBe(false)
    expect(store.ui.gyroActive).toBe(false)
    controls.dispose()
    camera.dispose()
  })

  it('recalibrates from the gamepad button once per press', () => {
    vi.stubGlobal('navigator', { getGamepads: () => [pad({ buttons: { 0: true } })] })
    const orientation = new DeviceOrientationController()
    orientation.push({ alpha: 0, beta: 0, gamma: 0 })
    const controls = new CameraControls({ gamepad: new GamepadController(), orientation })
    const camera = rig()

    controls.update(1 / 60, camera, { gamepad: true })
    // Pressing A binds the current pose; the camera only starts flying once a
    // stick actually asks for it.
    expect(camera.isOrientationCalibrated).toBe(true)
    expect(camera.isFree).toBe(false)

    controls.dispose()
    camera.dispose()
  })

  it('refuses to start head tracking when the browser denies permission', async () => {
    vi.stubGlobal('DeviceOrientationEvent', { requestPermission: async () => 'denied' })
    const controls = new CameraControls()
    expect(await controls.enableGyro()).toBe(false)
    expect(store.ui.gyroActive).toBe(false)
    controls.dispose()
  })

  it('attaches the sensor listener when permission is granted', async () => {
    vi.stubGlobal('DeviceOrientationEvent', { requestPermission: async () => 'granted' })
    const orientation = new DeviceOrientationController()
    const attach = vi.spyOn(orientation, 'attach')
    const controls = new CameraControls({ orientation })
    expect(await controls.enableGyro()).toBe(true)
    expect(attach).toHaveBeenCalled()
    controls.disableGyro()
    controls.dispose()
  })
})
