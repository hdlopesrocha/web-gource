// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { XR_OPTIONAL_FEATURES, XrSession, isXrSupported, type XrSessionLike, type XrSystemLike } from '../src/render/xr'
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

/** A fake `XRSession`: records listeners and fires them when ended. */
function fakeSession() {
  const listeners = new Set<() => void>()
  const removeEventListener = vi.fn((type: string, listener: () => void) => {
    if (type === 'end') listeners.delete(listener)
  })
  const addEventListener = vi.fn((type: string, listener: () => void) => {
    if (type === 'end') listeners.add(listener)
  })
  const end = vi.fn(async (): Promise<void> => {
    for (const listener of [...listeners]) listener()
  })
  const session: XrSessionLike = { addEventListener, removeEventListener, end }
  return { session, listeners, addEventListener, removeEventListener, end }
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

    // The tabletop is tipped flat, scaled to ~1.5 m across and placed in front
    // of the user, and the camera rides the rig so three can pose it.
    expect(camera.parent).toBe(rig)
    expect(rig.parent).toBe(scene)
    expect(root.scale.x).toBeCloseTo(1.5 / 40, 6)
    expect(root.position.z).toBeLessThan(0)
    expect(root.position.y).toBeCloseTo(0.95, 6)
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
    expect(controller.active).toBe(false)
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
})
