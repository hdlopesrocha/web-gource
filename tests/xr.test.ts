// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import {
  XR_OPTIONAL_FEATURES,
  XR_ORIGIN_BACK,
  XR_ORIGIN_HEIGHT,
  XR_VIEW_DEFAULT_HEIGHT,
  XR_VIEW_BACK,
  XrSession,
  isXrSupported,
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

  it('anchors the camera to the first real headset pose exactly once', async () => {
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

    // three poses the camera relative to the rig: its local Y is the headset's
    // real local-floor eye height (about 1.6 m for a standing user).
    const eyeHeight = 1.6
    camera.position.set(0, eyeHeight, 0)
    camera.updateMatrixWorld(true)

    expect(controller.fitCameraHeight()).toBe(true)
    // The pose is only anchored once; later frames leave the user's movement.
    expect(controller.fitCameraHeight()).toBe(false)

    await controller.exit()
  })

  it('moves the camera between the origin, top and gource views', async () => {
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
    expect(controller.view).toBe('gource')

    // A realistic headset pose: walking offset and a non-identity orientation.
    const rawPosition = new THREE.Vector3(0.5, 1.6, -0.25)
    const rawQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.3, 0.1))
    camera.position.copy(rawPosition)
    camera.quaternion.copy(rawQuaternion)
    camera.updateMatrixWorld(true)
    expect(controller.fitCameraHeight()).toBe(true)

    const height = XR_VIEW_DEFAULT_HEIGHT
    const target = new THREE.Vector3(2, -1, 0.4)
    controller.setFollowTarget(target)

    // Gource: an elevated vantage over the followed point.
    expect(controller.applyCameraPose()).toBe(true)
    camera.updateMatrixWorld(true)
    const gourceEye = new THREE.Vector3(target.x, target.y - XR_VIEW_BACK, target.z + height)
    expect(new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld).distanceTo(gourceEye)).toBeLessThan(1e-6)

    // Top: straight down over the whole scene.
    controller.setView('top')
    expect(controller.applyCameraPose()).toBe(true)
    camera.updateMatrixWorld(true)
    expect(new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld).distanceTo(new THREE.Vector3(0, 0, height))).toBeLessThan(1e-6)

    // Origin: close to the scene origin, looking at the scene.
    controller.setView('origin')
    expect(controller.applyCameraPose()).toBe(true)
    camera.updateMatrixWorld(true)
    const originEye = new THREE.Vector3(0, -XR_ORIGIN_BACK, XR_ORIGIN_HEIGHT)
    expect(new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld).distanceTo(originEye)).toBeLessThan(1e-6)

    // Changing the gource target moves the camera with it.
    controller.setView('gource')
    controller.setFollowTarget(new THREE.Vector3(-3, 2, 0.2))
    expect(controller.applyCameraPose()).toBe(true)

    await controller.exit()
  })

  it('dollies the camera along its view direction', async () => {
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
    const controller = new XrSession({ renderer, framing, xr: fakeXr(session), viewZoom: () => 1 })

    await controller.enter()
    camera.position.set(0, 1.6, 0)
    camera.updateMatrixWorld(true)
    expect(controller.fitCameraHeight()).toBe(true)

    // Top looks straight down, so a +1 dolly moves the eye 1 m closer.
    controller.setView('top')
    expect(controller.applyCameraPose()).toBe(true)
    camera.updateMatrixWorld(true)
    const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld)
    expect(eye.distanceTo(new THREE.Vector3(0, 0, XR_VIEW_DEFAULT_HEIGHT - 1))).toBeLessThan(1e-6)

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

  it('relays a controller select and detaches the listener on exit', async () => {
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
})
