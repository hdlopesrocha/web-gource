import * as THREE from 'three'
import type { SimAuthor } from '../sim/simulation'
import { avatarTextures, glowTextures, initialsFor } from './textures'
import { authorCssColor, colorForAuthor } from './palette'

export interface AuthorRenderOptions {
  /** Render the author name under the avatar. */
  showNames: boolean
  /** Additive halo behind the avatar. */
  showGlow: boolean
  /** Avatar scale multiplier. */
  scale: number
}

interface AvatarSlot {
  sprite: THREE.Sprite
  glow: THREE.Sprite
  material: THREE.SpriteMaterial
  glowMaterial: THREE.SpriteMaterial
  key: string | null
}

const AVATAR_HEIGHT = 3.4

/**
 * Avatars for the authors working in the repository.
 *
 * Every visible author gets a pooled sprite whose texture is a generated avatar
 * (initials + a hue derived from the author identity). Profile pictures are
 * deliberately not fetched: that would add one third-party request per author
 * and make the visualization depend on external assets. Generated avatars keep
 * the scene deterministic and offline friendly.
 */
export class AuthorField {
  readonly group = new THREE.Group()
  private slots: AvatarSlot[] = []
  private maxAuthors: number
  private options: AuthorRenderOptions

  constructor(maxAuthors = 64, options: AuthorRenderOptions = { showNames: true, showGlow: true, scale: 1 }) {
    this.maxAuthors = maxAuthors
    this.options = options
  }

  setOptions(options: Partial<AuthorRenderOptions>): void {
    this.options = { ...this.options, ...options }
    // Invalidate textures so the name/scale change takes effect.
    for (const slot of this.slots) slot.key = null
  }

  private acquire(index: number): AvatarSlot {
    const existing = this.slots[index]
    if (existing) return existing
    const material = new THREE.SpriteMaterial({ transparent: true, depthWrite: false, toneMapped: false })
    const glowMaterial = new THREE.SpriteMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      map: glowTextures.get('avatar-glow', JSON.stringify({ color: 'rgba(150,180,255,0.5)', softness: 0.12 })),
    })
    const sprite = new THREE.Sprite(material)
    const glow = new THREE.Sprite(glowMaterial)
    glow.scale.set(6.5, 6.5, 1)
    const slot: AvatarSlot = { sprite, glow, material, glowMaterial, key: null }
    this.group.add(glow)
    this.group.add(sprite)
    this.slots[index] = slot
    return slot
  }

  /** Position the visible avatars, updating textures only when they change. */
  sync(authors: readonly SimAuthor[]): void {
    let index = 0
    for (const author of authors) {
      if (!author.visible) continue
      if (index >= this.maxAuthors) break
      const slot = this.acquire(index)
      index += 1
      const colorHex = authorCssColor(author.author.colorIndex)
      const key = `${author.author.id}|${this.options.showNames ? 'name' : 'bare'}|${this.options.scale}`
      if (slot.key !== key) {
        slot.key = key
        const texture = avatarTextures.get(
          key,
          JSON.stringify({
            color: colorHex,
            initials: initialsFor(author.author.name),
            name: this.options.showNames ? author.author.name : undefined,
          }),
        )
        slot.material.map = texture
        slot.material.needsUpdate = true
        const aspect = (texture.userData.aspect as number) ?? 1
        const height = AVATAR_HEIGHT * this.options.scale
        slot.sprite.scale.set(height * aspect, height, 1)
      }
      if (!slot.material.map) continue
      slot.sprite.position.set(author.position.x, author.position.y + 2.5, author.position.z)
      slot.glow.position.copy(slot.sprite.position)
      slot.glow.scale.setScalar(6.5 * this.options.scale)
      slot.sprite.visible = true
      slot.glow.visible = this.options.showGlow
      slot.sprite.material.opacity = author.lastKind === 'delete' ? 0.95 : 1
    }
    for (let slotIndex = index; slotIndex < this.slots.length; slotIndex += 1) {
      const slot = this.slots[slotIndex]
      if (!slot) continue
      slot.sprite.visible = false
      slot.glow.visible = false
    }
  }

  /** Avatars that are still travelling towards their target (for trails). */
  movingAvatars(
    authors: readonly SimAuthor[],
    threshold = 1.4,
  ): { author: SimAuthor; color: THREE.Color }[] {
    const result: { author: SimAuthor; color: THREE.Color }[] = []
    for (const author of authors) {
      if (!author.visible) continue
      const distance = Math.hypot(
        author.target.x - author.position.x,
        author.target.y - author.position.y,
        author.target.z - author.position.z,
      )
      if (distance > threshold) result.push({ author, color: colorForAuthor(author.author.colorIndex, new THREE.Color()) })
    }
    return result
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot?.material.dispose()
      slot?.glowMaterial.dispose()
    }
    this.slots = []
    this.group.clear()
  }
}
