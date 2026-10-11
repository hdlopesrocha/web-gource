import * as THREE from 'three'
import type { ChangeKind } from '../timeline/types'
import { colorForChange } from './palette'

/**
 * Conversion factor from a world-space size to device pixels:
 * `viewportHeightPixels / (2 * tan(fov / 2))`.
 *
 * A point of `worldSize` units at distance `d` covers `worldSize * scale / d`
 * device pixels, which is exactly what the particle vertex shader computes.
 */
export function projectionScaleFor(viewportHeightPixels: number, fovDegrees: number): number {
  return viewportHeightPixels / (2 * Math.tan((fovDegrees * Math.PI) / 360))
}

/** Device-pixel size of a world-space sized point (mirrors the shader). */
export function pointSizePixels(worldSize: number, projectionScale: number, distance: number): number {
  return Math.max(1, (worldSize * projectionScale) / Math.max(0.001, distance))
}

/**
 * GPU particle pool for activity effects.
 *
 * A single `Points` object with a fixed capacity. Emitting reuses slots from a
 * free list, so bursts during heavy commits never allocate. Particles are
 * integrated on the CPU (a few thousand per frame is cheap) and rendered with
 * an additive point shader that needs no texture.
 */
export class ParticleField {
  readonly points: THREE.Points
  private capacity: number
  private positions: Float32Array
  private velocities: Float32Array
  private colors: Float32Array
  private sizes: Float32Array
  private alphas: Float32Array
  private lives: Float32Array
  private ages: Float32Array
  private drag: Float32Array
  private gravity: Float32Array
  private alive = 0
  private cursor = 0
  private material: THREE.ShaderMaterial
  private enabled = true
  private intensity = 1
  private colorDirty = false
  private sizeDirty = false

  constructor(capacity = 8000) {
    this.capacity = capacity
    this.positions = new Float32Array(capacity * 3)
    this.velocities = new Float32Array(capacity * 3)
    this.colors = new Float32Array(capacity * 3)
    this.sizes = new Float32Array(capacity)
    this.alphas = new Float32Array(capacity)
    this.lives = new Float32Array(capacity)
    this.ages = new Float32Array(capacity)
    this.drag = new Float32Array(capacity)
    this.gravity = new Float32Array(capacity)

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3))
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1))
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1))

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uProjectionScale: { value: 1000 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        uniform float uProjectionScale;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          // aSize is a world-space size; convert it to device pixels the same
          // way a sphere of that diameter would be projected.
          gl_PointSize = max(1.0, aSize * uProjectionScale / max(0.001, -mvPosition.z));
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 coord = gl_PointCoord - vec2(0.5);
          float dist = length(coord) * 2.0;
          if (dist > 1.0) discard;
          float falloff = pow(1.0 - dist, 1.8);
          gl_FragColor = vec4(vColor * falloff, vAlpha * falloff);
        }
      `,
    })

    this.points = new THREE.Points(geometry, this.material)
    this.points.frustumCulled = false
    this.points.renderOrder = 2
    geometry.setDrawRange(0, capacity)
    for (let index = 0; index < capacity; index += 1) this.alphas[index] = 0
  }

  get liveCount(): number {
    return this.alive
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.points.visible = enabled
  }

  /**
   * Conversion factor from world-space particle size to device pixels:
   * `drawingBufferHeight / (2 * tan(fov / 2))`.
   */
  setProjectionScale(scale: number): void {
    this.material.uniforms.uProjectionScale.value = scale
  }

  setIntensity(intensity: number): void {
    this.intensity = intensity
  }

  private acquire(): number {
    if (!this.enabled) return -1
    if (this.alive >= this.capacity) {
      // Recycle the oldest slot.
      const slot = this.cursor % this.capacity
      this.cursor += 1
      return slot
    }
    const slot = this.cursor % this.capacity
    this.cursor += 1
    this.alive += 1
    return slot
  }

  emit(options: {
    position: { x: number; y: number; z: number }
    velocity: { x: number; y: number; z: number }
    color: THREE.Color
    size: number
    life: number
    drag?: number
    gravity?: number
    alpha?: number
  }): void {
    const slot = this.acquire()
    if (slot < 0) return
    const offset = slot * 3
    this.positions[offset] = options.position.x
    this.positions[offset + 1] = options.position.y
    this.positions[offset + 2] = options.position.z
    this.velocities[offset] = options.velocity.x
    this.velocities[offset + 1] = options.velocity.y
    this.velocities[offset + 2] = options.velocity.z
    this.colors[offset] = options.color.r
    this.colors[offset + 1] = options.color.g
    this.colors[offset + 2] = options.color.b
    this.sizes[slot] = options.size
    this.alphas[slot] = options.alpha ?? 1
    this.lives[slot] = options.life
    this.ages[slot] = 0
    this.drag[slot] = options.drag ?? 1.6
    this.gravity[slot] = options.gravity ?? 0
    this.colorDirty = true
    this.sizeDirty = true
  }

  /**
   * Activity burst for a file change.
   *  - add    → upward green sparks
   *  - modify → tight amber sparks
   *  - delete → falling red embers
   *  - rename → violet swirl
   */
  burst(position: { x: number; y: number; z: number }, kind: ChangeKind, strength = 1, radius = 0.4): void {
    if (!this.enabled || this.intensity <= 0) return
    const color = colorForChange(kind)
    const count = Math.max(3, Math.min(42, Math.round((4 + Math.sqrt(strength) * 5) * this.intensity)))
    for (let index = 0; index < count; index += 1) {
      const angle = Math.random() * Math.PI * 2
      const elevation = (Math.random() - 0.5) * Math.PI
      let speed = 4 + Math.random() * 7
      let gravity = -2
      if (kind === 'add') speed *= 1.1
      if (kind === 'modify') gravity = -1
      if (kind === 'delete') {
        speed *= 0.85
        gravity = -9
      }
      if (kind === 'rename') gravity = 0
      this.emit({
        position: {
          x: position.x + (Math.random() - 0.5) * radius,
          y: position.y + (Math.random() - 0.5) * radius,
          z: position.z + (Math.random() - 0.5) * radius,
        },
        velocity: {
          x: Math.cos(angle) * Math.cos(elevation) * speed,
          y: Math.sin(elevation) * speed * 0.8 + (kind === 'add' ? 3 : 1),
          z: Math.sin(angle) * Math.cos(elevation) * speed,
        },
        color,
        size: 0.1 + Math.random() * 0.16,
        life: 0.5 + Math.random() * 0.85,
        drag: kind === 'delete' ? 1.1 : 1.8,
        gravity,
        alpha: 0.85,
      })
    }
  }

  /** Small trail dot behind a moving author. */
  trail(position: { x: number; y: number; z: number }, color: THREE.Color): void {
    if (!this.enabled || this.intensity <= 0) return
    this.emit({
      position,
      velocity: {
        x: (Math.random() - 0.5) * 0.6,
        y: (Math.random() - 0.5) * 0.6,
        z: (Math.random() - 0.5) * 0.6,
      },
      color,
      size: 0.09 + Math.random() * 0.09,
      life: 0.7 + Math.random() * 0.6,
      drag: 2.6,
      gravity: 0,
      alpha: 0.55,
    })
  }

  /** Integrate particles and fade them out. */
  update(dt: number): void {
    if (!this.enabled) return
    const attributes = this.points.geometry.attributes as {
      position: THREE.BufferAttribute
      aAlpha: THREE.BufferAttribute
    }
    let alphaDirty = false
    const step = Math.min(dt, 0.1)
    for (let slot = 0; slot < this.capacity; slot += 1) {
      if (this.lives[slot] <= 0) continue
      const offset = slot * 3
      this.ages[slot] += step
      const age = this.ages[slot]
      const life = this.lives[slot]
      if (age >= life) {
        this.lives[slot] = 0
        this.alphas[slot] = 0
        alphaDirty = true
        continue
      }
      const damping = Math.exp(-this.drag[slot] * step)
      this.velocities[offset] *= damping
      this.velocities[offset + 1] = this.velocities[offset + 1] * damping + this.gravity[slot] * step
      this.velocities[offset + 2] *= damping
      this.positions[offset] += this.velocities[offset] * step
      this.positions[offset + 1] += this.velocities[offset + 1] * step
      this.positions[offset + 2] += this.velocities[offset + 2] * step
      const fade = 1 - age / life
      this.alphas[slot] = fade * fade
      alphaDirty = true
    }
    attributes.position.needsUpdate = true
    if (alphaDirty) attributes.aAlpha.needsUpdate = true
    if (this.colorDirty) {
      ;(this.points.geometry.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true
      this.colorDirty = false
    }
    if (this.sizeDirty) {
      ;(this.points.geometry.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true
      this.sizeDirty = false
    }
  }

  /** Remove every live particle (used when seeking). */
  clear(): void {
    this.alphas.fill(0)
    this.lives.fill(0)
    this.alive = 0
    ;(this.points.geometry.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true
  }

  dispose(): void {
    this.points.geometry.dispose()
    this.material.dispose()
  }
}
