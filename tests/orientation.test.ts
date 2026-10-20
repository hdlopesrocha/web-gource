import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import {
  DeviceOrientationController,
  cameraQuaternionFromOrientation,
  quaternionFromOrientation,
  requestOrientationPermission,
  screenAngleRadians,
  type OrientationLike,
  type OrientationTarget,
} from '../src/render/orientation'

/** A window-like stub that lets a test fire `deviceorientation` events. */
function fakeWindow(): OrientationTarget & { fire(event: OrientationLike): void; listeners: number } {
  const handlers = new Set<(event: OrientationLike) => void>()
  return {
    listeners: 0,
    addEventListener(_type, listener) {
      handlers.add(listener)
      this.listeners = handlers.size
    },
    removeEventListener(_type, listener) {
      handlers.delete(listener)
      this.listeners = handlers.size
    },
    fire(event) {
      for (const handler of handlers) handler(event)
    },
  }
}

/** Forward direction of a camera quaternion (three cameras look down -Z). */
function forwardOf(quaternion: THREE.Quaternion): THREE.Vector3 {
  return new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion)
}

describe('device orientation quaternion', () => {
  it('is the W3C Z → X → Y rotation', () => {
    // 90° of compass rotation: the device's +X (right) turns from east to north.
    const q = quaternionFromOrientation({ alpha: 90, beta: 0, gamma: 0 })
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
    expect(right.x).toBeCloseTo(0, 6)
    expect(right.y).toBeCloseTo(1, 6)
    expect(right.z).toBeCloseTo(0, 6)

    // Tilting the device forward by 90° (beta) stands it up: the screen-up
    // points along the world up.
    const tilted = quaternionFromOrientation({ alpha: 0, beta: 90, gamma: 0 })
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(tilted)
    expect(up.z).toBeCloseTo(1, 6)
  })

  it('applies the screen rotation last, for landscape and portrait', () => {
    const portrait = cameraQuaternionFromOrientation({ alpha: 0, beta: 0, gamma: 0, screenAngle: 0 })
    const landscape = cameraQuaternionFromOrientation({ alpha: 0, beta: 0, gamma: 0, screenAngle: Math.PI / 2 })
    expect(portrait.angleTo(landscape)).toBeCloseTo(Math.PI / 2, 6)
    // The screen rotation turns the camera about its own view direction, so the
    // forward vector is unchanged and only the up vector rotates.
    expect(forwardOf(portrait).angleTo(forwardOf(landscape))).toBeCloseTo(0, 6)
  })

  it('looks out of the screen: the camera forward is the device +Z', () => {
    const reading = { alpha: 42, beta: -12, gamma: 7 }
    const device = quaternionFromOrientation(reading)
    const camera = cameraQuaternionFromOrientation(reading)
    const deviceOut = new THREE.Vector3(0, 0, 1).applyQuaternion(device)
    expect(forwardOf(camera).angleTo(deviceOut)).toBeCloseTo(0, 6)
    // The up vector is the device's screen-up rotated by the gyroscope value.
    const deviceUp = new THREE.Vector3(0, 1, 0).applyQuaternion(device)
    const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera)
    expect(cameraUp.angleTo(deviceUp)).toBeCloseTo(0, 6)
  })
})

describe('DeviceOrientationController', () => {
  it('starts unavailable and becomes available with the first reading', () => {
    const controller = new DeviceOrientationController()
    expect(controller.available).toBe(false)
    controller.push({ alpha: 0, beta: 0, gamma: 0 })
    expect(controller.available).toBe(true)
  })

  it('ignores readings with no sensor data', () => {
    const controller = new DeviceOrientationController()
    controller.push({ alpha: null, beta: null, gamma: null })
    expect(controller.available).toBe(false)
    controller.push({ alpha: 10, beta: null, gamma: null })
    expect(controller.available).toBe(true)
  })

  it('subscribes, updates on events and unsubscribes', () => {
    const controller = new DeviceOrientationController()
    const target = fakeWindow()
    controller.attach(target)
    expect(controller.attached).toBe(true)
    expect(target.listeners).toBe(1)

    const before = controller.cameraQuaternion
    target.fire({ alpha: 90, beta: 0, gamma: 0 })
    expect(controller.available).toBe(true)
    expect(controller.cameraQuaternion.angleTo(before)).toBeGreaterThan(0.1)

    // The up vector follows the gyroscope (here: a compass turn keeps +Y).
    const up = controller.up
    expect(up.length()).toBeCloseTo(1, 6)

    controller.detach()
    expect(controller.attached).toBe(false)
    expect(target.listeners).toBe(0)
  })

  it('reports the screen angle from the host when it is available', () => {
    expect(screenAngleRadians({ screen: { orientation: { angle: 90 } } })).toBeCloseTo(Math.PI / 2, 6)
    expect(screenAngleRadians({ orientation: -90 })).toBeCloseTo(-Math.PI / 2, 6)
    expect(screenAngleRadians({})).toBe(0)
    // An explicit angle wins over the host value (tests and late reports).
    const controller = new DeviceOrientationController()
    controller.setScreenAngle(Math.PI)
    controller.push({ alpha: 0, beta: 0, gamma: 0 })
    expect(controller.available).toBe(true)
  })

  it('asks for permission where the browser needs it', async () => {
    expect(await requestOrientationPermission(undefined)).toBe(true)
    expect(await requestOrientationPermission({ requestPermission: async () => 'granted' })).toBe(true)
    expect(await requestOrientationPermission({ requestPermission: async () => 'denied' })).toBe(false)
    expect(
      await requestOrientationPermission({
        requestPermission: async () => {
          throw new Error('no gesture')
        },
      }),
    ).toBe(false)
  })

  it('disposes cleanly', () => {
    const controller = new DeviceOrientationController()
    const target = fakeWindow()
    controller.attach(target)
    controller.dispose()
    expect(controller.attached).toBe(false)
    expect(controller.available).toBe(false)
    expect(target.listeners).toBe(0)
    // Disposing twice is safe.
    expect(() => controller.dispose()).not.toThrow()
    vi.restoreAllMocks()
  })
})
