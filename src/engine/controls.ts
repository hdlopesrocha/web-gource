import type { OrbitCamera } from '../render/camera'
import { DEFAULT_GAMEPAD_OPTIONS, GamepadController } from '../render/gamepad'
import { DeviceOrientationController, requestOrientationPermission } from '../render/orientation'
import { store } from '../state/store'

/**
 * Camera control devices: a gamepad and the device's gyroscope.
 *
 * Both drive the camera's free 6-DOF mode (see {@link OrbitCamera}), and both
 * are opt-in: until one of them is enabled and actually reporting, the camera
 * behaves exactly as before. The class owns the device I/O; the camera owns the
 * maths, and the store carries the settings and the status the UI shows.
 */
export interface ControlOptions {
  /** Fly the camera with a connected gamepad. */
  gamepad?: boolean
  /** Multiplier on the gamepad's rotation and translation speeds (1 = default). */
  gamepadSensitivity?: number
  /** Follow the device's gyroscope (head tracking). */
  gyro?: boolean
}

export interface ControlDependencies {
  gamepad?: GamepadController
  orientation?: DeviceOrientationController
}

const MIN_SENSITIVITY = 0.2
const MAX_SENSITIVITY = 3

export class CameraControls {
  private readonly gamepad: GamepadController
  private readonly orientation: DeviceOrientationController
  /** True while the devices are the ones holding the camera. */
  private driving = false
  private appliedSensitivity = 1

  constructor(dependencies: ControlDependencies = {}) {
    this.gamepad = dependencies.gamepad ?? new GamepadController()
    this.orientation = dependencies.orientation ?? new DeviceOrientationController()
  }

  get gamepadConnected(): boolean {
    return this.gamepad.connected
  }

  /** True once a gyroscope reading has arrived. */
  get gyroAvailable(): boolean {
    return this.orientation.available
  }

  /**
   * Ask for motion-sensor permission where the browser needs it (iOS 13+).
   *
   * Must be called from a user gesture — the settings toggle — because that is
   * the only place the browser accepts the prompt.
   */
  async enableGyro(): Promise<boolean> {
    const granted = await requestOrientationPermission()
    if (granted) this.orientation.attach()
    return granted
  }

  disableGyro(): void {
    this.orientation.detach()
  }

  /** Bind the current device pose to the current camera pose. */
  recalibrate(rig: OrbitCamera): void {
    if (!this.orientation.available) return
    rig.calibrateOrientation(this.orientation.cameraQuaternion)
  }

  /** Poll the devices and move the camera. Called once per rendered frame. */
  update(dt: number, rig: OrbitCamera, options: ControlOptions): void {
    const useGyro = options.gyro === true
    const useGamepad = options.gamepad === true
    let driving = false

    if (useGyro) {
      if (!this.orientation.attached) this.orientation.attach()
      if (this.orientation.available) {
        rig.applyOrientation(this.orientation.cameraQuaternion)
        driving = true
      }
    }

    if (useGamepad) {
      const sensitivity = clamp(options.gamepadSensitivity ?? 1, MIN_SENSITIVITY, MAX_SENSITIVITY)
      if (sensitivity !== this.appliedSensitivity) {
        this.appliedSensitivity = sensitivity
        this.gamepad.setOptions({
          rotateSpeed: DEFAULT_GAMEPAD_OPTIONS.rotateSpeed * sensitivity,
          moveSpeed: DEFAULT_GAMEPAD_OPTIONS.moveSpeed * sensitivity,
        })
      }
      const state = this.gamepad.poll()
      if (state.connected) {
        rig.rotateLocal(state.yaw, state.pitch, state.roll, dt)
        rig.translateLocal(state.forward, state.side, state.up, dt)
        if (state.calibrate) this.recalibrate(rig)
        driving = true
      }
    } else {
      // Keep the "connected" flag the UI shows up to date even while the pad is
      // not allowed to move the camera.
      this.gamepad.poll()
    }

    if (!driving && this.driving) rig.leaveFreeMode()
    this.driving = driving

    const connected = this.gamepad.connected
    if (store.ui.gamepadConnected !== connected) store.ui.gamepadConnected = connected
    const gyroActive = useGyro && this.orientation.available
    if (store.ui.gyroActive !== gyroActive) store.ui.gyroActive = gyroActive
  }

  dispose(): void {
    this.orientation.dispose()
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
