// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import {
  XR_2D_CAMERA_HEIGHT,
  XR_EYE_HEIGHT_SCALE,
  XR_OPTIONAL_FEATURES,
  XR_OVERVIEW_DEFAULT_HEIGHT,
  XR_OVERVIEW_RADIUS,
  XrSession,
  isXrSupported,
  nextXrCameraMode,
  type XrSessionLike,
  type XrSystemLike,
} from '../src/render/xr'
import { store } from '../src/state/store'

/**
 * WebXR session bookkeeping.
 *
 * There is no headset (and no WebGL) in jsdom, so every dependency is faked:
 * `navigator.xr`, the session object and three's `renderer.xr` manager. What is
 * verified here is the *logic* — what gets requested, what gets enabled, what a
 * failure does, and what an `end` event restores. Whether a real headset renders
 * the scene cannot be checked without one.
 */

/** A fake `XRSession`: records listeners and fires them when ended or selected. */
function fakeSession() {
  const listeners = new Set<() => void>()
  const selectListeners = new Set<() => void>()
  const removeEventListener = vi.fn((type: string, listener: () => void) => {
    if (type === 'end') listeners.delete(listener)
    if (type === 'select') selectListeners.delete(listener)
  })
  const addEventListener = vi.fn((type: string, listener: () => void) => {
    if (type === 'end') listeners.add(listener)
    if (type === 'select') selectListeners.add(listener)
  })
  const end = vi.fn(async (): Promise<void> => {
    for (const listener of [...listeners]) listener()
  })
  const fireSelect = (): void => {
    for (const listener of [...selectListeners]) listener()
  }
  const session: XrSessionLike = { addEventListener, removeEventListener, end }
  return { session, listeners, selectListeners, addEventListener, removeEventListener, end, fireSelect }
}

/** A fake `THREE.WebGLRenderer`: only the `xr` manager is used by the session. */
function fakeRenderer() {
  return {
    xr: {
      enabled: false,
      isPresenting: false,
      setReferenceSpaceType: vi.fn(),
      setSession: vi.fn(async (_session: unknown): Promise<void> => undefined),
    },
  }
}

/** A fake `navigator.xr` that hands out the given session. */
function fakeXr(session: XrSessionLike): XrSystemLike {
  return {
    isSessionSupported: vi.fn(async () => true),
    requestSession: vi.fn(async () => session),
  }
}

beforeEach(() => {
  store.ui.xrSupported = false
  store.ui.xrActive = false
  store.ui.xrError = null
})

describe('isXrSupported', () => {
  it('reports unsupported when navigator.xr is missing', async () => {
    const nav = navigator as unknown as { xr?: unknown }
    const had = 'xr' in nav
    const previous = nav.xr
    delete nav.xr
    try {
      expect(await isXrSupported()).toBe(false)
    } finally {
      if (had) nav.xr = previous
    }
    // Passing null explicitly is the same answer.
    expect(await isXrSupported(null)).toBe(false)
  })

  it('reports unsupported when isSessionSupported rejects', async () => {
    const xr: XrSystemLike = {
      isSessionSupported: vi.fn(async () => {
        throw new Error('no immersive device')
      }),
      requestSession: vi.fn(),
    }
    expect(await isXrSupported(xr)).toBe(false)
    expect(xr.isSessionSupported).toHaveBeenCalledWith('immersive-vr')
  })

  it('reports supported when the browser accepts immersive-vr', async () => {
    const xr: XrSystemLike = { isSessionSupported: vi.fn(async () => true), requestSession: vi.fn() }
    expect(await isXrSupported(xr)).toBe(true)
  })
})

describe('XrSession', () => {
  it('requests an immersive session with the optional features and enables XR', async () => {
    const renderer = fakeRenderer()
    const { session } = fakeSession()
    const xr = fakeXr(session)
    const controller = new XrSession({ renderer, xr })

    await controller.enter()

    expect(xr.requestSession).toHaveBeenCalledWith('immersive-vr', {
      optionalFeatures: [...XR_OPTIONAL_FEATURES],
    })
    expect(renderer.xr.enabled).toBe(true)
    expect(renderer.xr.setReferenceSpaceType).toHaveBeenCalledWith('local-floor')
    expect(renderer.xr.setSession).toHaveBeenCalledWith(session)
    expect(controller.active).toBe(true)
    expect(store.ui.xrActive).toBe(true)
    expect(store.ui.xrError).toBeNull()
  })

  it('only marks the session active once setSession has resolved', async () => {
    const renderer = fakeRenderer()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    renderer.xr.setSession.mockImplementation(() => gate)
    const controller = new XrSession({ renderer, xr: fakeXr(fakeSession().session) })

    const pending = controller.enter()
    await Promise.resolve()
    await Promise.resolve()
    expect(store.ui.xrActive).toBe(false)

    release()
    await pending
    expect(store.ui.xrActive).toBe(true)
  })

  it('restores the scene, the camera and the flags when the session ends', async () => {
    const renderer = fakeRenderer()
    const { session, listeners } = fakeSession()
    const root = new THREE.Group()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    camera.position.set(4, 5, 6)
    camera.up.set(0, 0, 1)
    const rig = new THREE.Group()
    const scene = new THREE.Group()
    const framing = {
      rig,
      scene,
      camera,
      root,
      bounds: () => ({ center: { x: 10, y: -5, z: 0 }, radius: 20 }),
    }
    const controller = new XrSession({ renderer, framing, xr: fakeXr(session) })

    await controller.enter()

    // The tree keeps its tabletop scale but is centred on the scene origin, and
    // the rig stays on the local floor there; the headset pose supplies the
    // real eye height. The camera rides the rig so three can pose it.
    const scale = 1.5 / 40
    expect(camera.parent).toBe(rig)
    expect(rig.parent).toBe(scene)
    expect(root.scale.x).toBeCloseTo(scale, 6)
    expect(root.position.x).toBeCloseTo(-10 * scale, 6)
    expect(root.position.y).toBeCloseTo(5 * scale, 6)
    expect(root.position.z).toBeCloseTo(0, 6)
    expect(rig.position.x).toBeCloseTo(0, 6)
    expect(rig.position.y).toBeCloseTo(0, 6)
    expect(rig.position.z).toBeCloseTo(0, 6)
    expect(store.ui.xrActive).toBe(true)

    for (const listener of [...listeners]) listener()

    expect(store.ui.xrActive).toBe(false)
    expect(renderer.xr.enabled).toBe(false)
    expect(camera.parent).toBeNull()
    expect(camera.position.x).toBeCloseTo(4, 6)
    expect(camera.position.z).toBeCloseTo(6, 6)
    expect(camera.up.z).toBeCloseTo(1, 6)
    expect(root.scale.x).toBe(1)
    expect(root.position.length()).toBe(0)
    expect(root.quaternion.equals(new THREE.Quaternion())).toBe(true)
    expect(rig.position.length()).toBe(0)
    expect(rig.quaternion.equals(new THREE.Quaternion())).toBe(true)
    expect(controller.active).toBe(false)
  })

  it('stands the user on the local floor at the scene origin', async () => {
    const renderer = fakeRenderer()
    const { session } = fakeSession()
    const root = new THREE.Group()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    camera.position.set(7, -3, 9)
    const rig = new THREE.Group()
    const scene = new THREE.Group()
    const framing = {
      rig,
      scene,
      camera,
      root,
      bounds: () => ({ center: { x: 0, y: 0, z: 0 }, radius: 30 }),
    }
    const controller = new XrSession({ renderer, framing, xr: fakeXr(session) })

    await controller.enter()

    const scale = 1.5 / 60
    // The rig sits on the local-floor origin; the headset pose alone supplies
    // the real eye height, regardless of where the on-screen camera is.
    expect(rig.position.x).toBeCloseTo(0, 6)
    expect(rig.position.y).toBeCloseTo(0, 6)
    expect(rig.position.z).toBeCloseTo(0, 6)
    // The world is no longer tipped or pushed in front: it is only scaled and
    // centred, so its local axes can be treated as the room's.
    expect(root.quaternion.equals(new THREE.Quaternion())).toBe(true)
    expect(root.position.length()).toBeCloseTo(0, 6)
    expect(root.scale.x).toBeCloseTo(scale, 6)
    // The rig is tipped so the tree's +Z (the plane normal) becomes the room up.
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rig.quaternion)
    expect(up.z).toBeCloseTo(1, 6)

    await controller.exit()
    expect(rig.position.length()).toBe(0)
    expect(rig.quaternion.equals(new THREE.Quaternion())).toBe(true)
  })

  it('lowers the eyes to a quarter of the measured headset height', async () => {
    const renderer = fakeRenderer()
    const { session } = fakeSession()
    const root = new THREE.Group()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    camera.position.set(7, -3, 9)
    const rig = new THREE.Group()
    const scene = new THREE.Group()
    const framing = {
      rig,
      scene,
      camera,
      root,
      bounds: () => ({ center: { x: 0, y: 0, z: 0 }, radius: 30 }),
    }
    const controller = new XrSession({ renderer, framing, xr: fakeXr(session) })

    await controller.enter()

    // three has posed the camera relative to the rig: its local Y is the
    // headset's real local-floor eye height (about 1.6 m for a standing user).
    const eyeHeight = 1.6
    camera.position.set(0, eyeHeight, 0)
    camera.updateMatrixWorld(true)

    expect(controller.fitCameraHeight()).toBe(true)
    // The rig moves down so the eyes finish at eyeHeight / 4 above the tree.
    expect(rig.position.z).toBeCloseTo(-eyeHeight * (1 - XR_EYE_HEIGHT_SCALE), 6)
    const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld)
    expect(eye.z).toBeCloseTo(eyeHeight * XR_EYE_HEIGHT_SCALE, 6)
    // The pose is only fitted once; later frames leave the user's movement alone.
    expect(controller.fitCameraHeight()).toBe(false)
    expect(rig.position.z).toBeCloseTo(-eyeHeight * (1 - XR_EYE_HEIGHT_SCALE), 6)

    await controller.exit()
    expect(rig.position.z).toBe(0)
  })

  it('cycles the standard overview, fixed-centre and top-down camera modes with the headset pose intact', async () => {
    const renderer = fakeRenderer()
    const { session } = fakeSession()
    const root = new THREE.Group()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    const rig = new THREE.Group()
    const scene = new THREE.Group()
    const framing = {
      rig,
      scene,
      camera,
      root,
      bounds: () => ({ center: { x: 0, y: 0, z: 0 }, radius: 30 }),
    }
    const controller = new XrSession({ renderer, framing, xr: fakeXr(session) })

    await controller.enter()
    expect(controller.mode).toBe('free')

    // A realistic headset pose: walking offset and a non-identity orientation.
    const rawPosition = new THREE.Vector3(0.5, 1.6, -0.25)
    const rawQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.3, 0.1))
    camera.position.copy(rawPosition)
    camera.quaternion.copy(rawQuaternion)
    camera.updateMatrixWorld(true)
    expect(controller.fitCameraHeight()).toBe(true)

    // Standard overview: the eyes are pinned to the elevated vantage, looking
    // at the table centre, whatever the headset translation was.
    const height = XR_OVERVIEW_DEFAULT_HEIGHT
    const horizontal = Math.sqrt(XR_OVERVIEW_RADIUS ** 2 - height ** 2)
    const vantage = new THREE.Vector3(0, -horizontal, height)
    expect(controller.applyCameraMode()).toBe(true)
    camera.updateMatrixWorld(true)
    const free = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld)
    expect(free.distanceTo(vantage)).toBeLessThan(1e-6)
    const freeForward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()))
    expect(freeForward.angleTo(vantage.clone().negate().normalize())).toBeLessThan(1e-6)
    expect(controller.headForGaze(new THREE.Matrix4())).toBe(false)

    // Fixed centre: horizontal translation is cancelled, orientation is kept,
    // and the height is captured from the vantage the user was just at.
    controller.setCameraMode('center')
    expect(controller.applyCameraMode()).toBe(true)
    camera.updateMatrixWorld(true)
    const centre = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld)
    expect(centre.x).toBeCloseTo(0, 6)
    expect(centre.y).toBeCloseTo(0, 6)
    expect(centre.z).toBeCloseTo(height, 6)
    const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0))
    const expectedOrientation = tilt.clone().multiply(rawQuaternion)
    const centreOrientation = new THREE.Quaternion()
    camera.getWorldQuaternion(centreOrientation)
    expect(centreOrientation.angleTo(expectedOrientation)).toBeLessThan(1e-6)
    expect(controller.headForGaze(new THREE.Matrix4())).toBe(false)

    // 2D: the view is locked top-down at the overview height, while gaze uses
    // the raw headset orientation from the same position.
    controller.setCameraMode('2d')
    expect(controller.applyCameraMode()).toBe(true)
    camera.updateMatrixWorld(true)
    const overview = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld)
    expect(overview.x).toBeCloseTo(0, 6)
    expect(overview.y).toBeCloseTo(0, 6)
    expect(overview.z).toBeCloseTo(Math.max(height, XR_2D_CAMERA_HEIGHT), 6)
    expect(camera.getWorldQuaternion(new THREE.Quaternion()).angleTo(new THREE.Quaternion())).toBeLessThan(1e-6)

    const gaze = new THREE.Matrix4()
    expect(controller.headForGaze(gaze)).toBe(true)
    const gazePosition = new THREE.Vector3().setFromMatrixPosition(gaze)
    expect(gazePosition.distanceTo(overview)).toBeLessThan(1e-6)
    const gazeOrientation = new THREE.Quaternion().setFromRotationMatrix(gaze)
    expect(gazeOrientation.angleTo(expectedOrientation)).toBeLessThan(1e-6)

    // Back to standard: the fixed vantage returns.
    controller.setCameraMode('free')
    expect(controller.applyCameraMode()).toBe(true)
    camera.updateMatrixWorld(true)
    const freeAgain = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld)
    expect(freeAgain.distanceTo(vantage)).toBeLessThan(1e-6)
    expect(controller.headForGaze(new THREE.Matrix4())).toBe(false)

    expect(nextXrCameraMode('free')).toBe('2d')
    expect(nextXrCameraMode('2d')).toBe('center')
    expect(nextXrCameraMode('center')).toBe('free')
    await controller.exit()
  })

  it('records an error and stays out of VR when requestSession rejects', async () => {
    const renderer = fakeRenderer()
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    const controller = new XrSession({
      renderer,
      xr: {
        isSessionSupported: async () => true,
        requestSession: async () => {
          throw denied
        },
      },
    })
    store.ui.xrError = null

    await controller.enter()

    expect(store.ui.xrError).toMatch(/denied/i)
    expect(store.ui.xrActive).toBe(false)
    expect(controller.active).toBe(false)
    expect(renderer.xr.enabled).toBe(false)
    expect(renderer.xr.setSession).not.toHaveBeenCalled()
  })

  it('clears the error and explains when there is no WebXR device', async () => {
    const renderer = fakeRenderer()
    const controller = new XrSession({ renderer, xr: null })
    store.ui.xrError = 'stale'

    await controller.enter()

    expect(store.ui.xrError).toMatch(/not available/i)
    expect(store.ui.xrActive).toBe(false)
    expect(renderer.xr.setSession).not.toHaveBeenCalled()
  })

  it('puts everything back when setSession itself fails', async () => {
    const renderer = fakeRenderer()
    const { session } = fakeSession()
    renderer.xr.setSession.mockImplementation(async () => {
      throw new Error('attach failed')
    })
    const root = new THREE.Group()
    const camera = new THREE.PerspectiveCamera()
    const rig = new THREE.Group()
    const scene = new THREE.Group()
    const controller = new XrSession({
      renderer,
      framing: { rig, scene, camera, root, bounds: () => ({ center: { x: 0, y: 0, z: 0 }, radius: 10 }) },
      xr: fakeXr(session),
    })

    await controller.enter()

    expect(store.ui.xrError).toMatch(/attach failed/i)
    expect(store.ui.xrActive).toBe(false)
    expect(renderer.xr.enabled).toBe(false)
    expect(camera.parent).toBeNull()
    expect(root.scale.x).toBe(1)
    // The half-attached session is ended rather than left running.
    expect(session.end).toHaveBeenCalled()
  })

  it('leaves the session on exit()', async () => {
    const renderer = fakeRenderer()
    const { session, end } = fakeSession()
    const controller = new XrSession({ renderer, xr: fakeXr(session) })

    await controller.enter()
    await controller.exit()

    expect(end).toHaveBeenCalled()
    expect(store.ui.xrActive).toBe(false)
    expect(controller.active).toBe(false)
    expect(renderer.xr.enabled).toBe(false)
  })

  it('removes its session listener on dispose and ignores further enters', async () => {
    const renderer = fakeRenderer()
    const { session, listeners, removeEventListener } = fakeSession()
    const controller = new XrSession({ renderer, xr: fakeXr(session) })

    await controller.enter()
    expect(listeners.size).toBe(1)

    controller.dispose()

    expect(removeEventListener).toHaveBeenCalled()
    expect(listeners.size).toBe(0)
    expect(store.ui.xrActive).toBe(false)
    expect(controller.active).toBe(false)

    await controller.enter()
    expect(renderer.xr.setSession).toHaveBeenCalledTimes(1)
  })

  it('recenters the standard overview on the current heading', async () => {
    const renderer = fakeRenderer()
    const { session } = fakeSession()
    const root = new THREE.Group()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    const rig = new THREE.Group()
    const scene = new THREE.Group()
    const framing = {
      rig,
      scene,
      camera,
      root,
      bounds: () => ({ center: { x: 0, y: 0, z: 0 }, radius: 30 }),
    }
    const controller = new XrSession({ renderer, framing, xr: fakeXr(session) })

    await controller.enter()

    const eyeHeight = 1.65
    camera.position.set(0.35, eyeHeight, -0.2)
    camera.quaternion.setFromEuler(new THREE.Euler(0.18, 0.72, -0.08))
    camera.updateMatrixWorld(true)
    expect(controller.fitCameraHeight()).toBe(true)
    controller.applyCameraMode()
    camera.updateMatrixWorld(true)

    // The user turns their head: recenter should make that the new forward.
    camera.quaternion.setFromEuler(new THREE.Euler(-0.4, 2.1, 0.35))
    camera.updateMatrixWorld(true)
    const upBefore = new THREE.Vector3(0, 1, 0).applyQuaternion(
      camera.getWorldQuaternion(new THREE.Quaternion()),
    )

    expect(controller.recenter()).toBe(true)
    camera.updateMatrixWorld(true)

    // The eyes stay on the elevated vantage, so recenter only re-aims the view.
    const height = XR_OVERVIEW_DEFAULT_HEIGHT
    const horizontal = Math.sqrt(XR_OVERVIEW_RADIUS ** 2 - height ** 2)
    const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld)
    expect(eye.x).toBeCloseTo(0, 5)
    expect(eye.y).toBeCloseTo(-horizontal, 5)
    expect(eye.z).toBeCloseTo(height, 5)

    // The current heading now faces the standard direction, i.e. the table
    // centre, and the world up is the head-up captured at the click.
    const world = new THREE.Quaternion()
    camera.getWorldQuaternion(world)
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(world)
    const toCentre = new THREE.Vector3(0, horizontal, -height).normalize()
    expect(forward.angleTo(toCentre)).toBeLessThan(1e-6)
    // No roll relative to the head-up captured at the click.
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(world)
    expect(Math.abs(right.dot(controller.up))).toBeLessThan(1e-6)
    // The stored up is the head-up from the moment of the click.
    expect(controller.up.angleTo(upBefore)).toBeLessThan(1e-6)

    // A second recenter is a no-op: the view is already on the reference pose.
    expect(controller.recenter()).toBe(false)
    await controller.exit()
  })

  it('recenters from a controller select and detaches the listener on exit', async () => {
    const renderer = fakeRenderer()
    const { session, selectListeners, fireSelect } = fakeSession()
    const onSelect = vi.fn()
    const controller = new XrSession({ renderer, xr: fakeXr(session), onSelect })

    await controller.enter()
    expect(selectListeners.size).toBe(1)

    fireSelect()
    expect(onSelect).toHaveBeenCalledTimes(1)

    await controller.exit()
    expect(selectListeners.size).toBe(0)
    fireSelect()
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('recenters without a session as a harmless no-op', () => {
    const controller = new XrSession({ renderer: fakeRenderer(), xr: null })
    expect(controller.recenter()).toBe(false)
  })
})
