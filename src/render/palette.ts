import * as THREE from 'three'
import type { AudioLevels } from '../engine/audio/analysis'
import type { ChangeKind } from '../timeline/types'

/**
 * Colours for the visualization.
 *
 * Files are coloured by extension (like Gource), authors get distinct saturated
 * hues, and change kinds drive the activity effects.
 */

/** Explicit hues for common extensions so the palette stays recognisable. */
const EXTENSION_HUES: Record<string, number> = {
  ts: 0.58, tsx: 0.56, js: 0.14, jsx: 0.12, mjs: 0.13, cjs: 0.13,
  vue: 0.42, svelte: 0.06, html: 0.05, css: 0.53, scss: 0.85, less: 0.83, sass: 0.84,
  json: 0.11, yml: 0.09, yaml: 0.09, toml: 0.08, ini: 0.08, env: 0.08,
  md: 0.6, mdx: 0.6, txt: 0.6, rst: 0.6,
  py: 0.16, rb: 0.98, go: 0.5, rs: 0.03, java: 0.08, kt: 0.28, swift: 0.02, c: 0.62, h: 0.64,
  cpp: 0.55, hpp: 0.57, cc: 0.54, cs: 0.76, php: 0.7, scala: 0.02, dart: 0.5, lua: 0.22,
  sh: 0.33, bash: 0.33, zsh: 0.33, fish: 0.34, sql: 0.44, graphql: 0.86, proto: 0.47,
  png: 0.9, jpg: 0.88, jpeg: 0.88, gif: 0.92, svg: 0.35, webp: 0.87, ico: 0.9,
  lock: 0.0, sum: 0.02,
}

const CHANGE_COLORS: Record<ChangeKind, THREE.Color> = {
  add: new THREE.Color(0x54ff9f),
  modify: new THREE.Color(0xffc857),
  delete: new THREE.Color(0xff5d6c),
  rename: new THREE.Color(0xb98cff),
}

const AUTHOR_HUES = [0.02, 0.09, 0.16, 0.28, 0.36, 0.46, 0.53, 0.6, 0.68, 0.76, 0.83, 0.91]

const scratch = new THREE.Color()

export function colorForExtension(extension: string, target = new THREE.Color()): THREE.Color {
  const hue = EXTENSION_HUES[extension]
  // The HSL values are authored in sRGB. `setHSL` defaults to the linear
  // working space, which would turn every file into a washed-out pastel once
  // the renderer converts the result back to sRGB.
  if (hue !== undefined) return target.setHSL(hue, 0.72, 0.62, THREE.SRGBColorSpace)
  // Unknown extensions: derive a stable hue from the string.
  let hash = 0
  for (let index = 0; index < extension.length; index += 1) hash = (hash * 31 + extension.charCodeAt(index)) % 997
  return target.setHSL((hash % 360) / 360, 0.55, 0.6, THREE.SRGBColorSpace)
}

export function colorForAuthor(colorIndex: number, target = new THREE.Color()): THREE.Color {
  const hue = AUTHOR_HUES[colorIndex % AUTHOR_HUES.length]
  return target.setHSL(hue, 0.85, 0.62, THREE.SRGBColorSpace)
}

export function authorCssColor(colorIndex: number): string {
  return `#${colorForAuthor(colorIndex, scratch).getHexString()}`
}

export function colorForChange(kind: ChangeKind): THREE.Color {
  return CHANGE_COLORS[kind]
}

export function cssColorForChange(kind: ChangeKind): string {
  return `#${CHANGE_COLORS[kind].getHexString()}`
}

/** Directory colour: a soft blue-white so the structure reads as architecture. */
export const DIR_COLOR = new THREE.Color(0x9fd0ff)
/** Colour used when a node was just touched: bright and near-white. */
export const HIGHLIGHT_COLOR = new THREE.Color(0xffffff)
export const ROOT_COLOR = new THREE.Color(0xfff1c9)

/**
 * The activity tint shared by the folder glow and the plasma volume.
 *
 * The two layers are meant to read as one light: the same directory colour,
 * scaled by the layer's own intensity and the bass gain, with the hue rotated
 * by the bass. Using one function for both is what keeps the halos and the
 * plasma the same colour — including when the music moves them.
 */
export function activityTint(
  intensity: number,
  audio: AudioLevels | null,
  target = new THREE.Color(),
): THREE.Color {
  const gain = audio ? 1 + audio.bass * 0.45 : 1
  const brightness = intensity * gain
  target.setRGB(
    Math.min(1.5, DIR_COLOR.r * brightness),
    Math.min(1.5, DIR_COLOR.g * brightness),
    Math.min(1.5, DIR_COLOR.b * brightness),
  )
  const hue = audio ? audio.bass * 0.25 : 0
  if (hue !== 0) target.offsetHSL(hue, 0, 0)
  return target
}

export function backgroundColor(): THREE.Color {
  return new THREE.Color(0x05070e)
}

/** Faint grid lines behind the tree. */
export function gridColor(): THREE.Color {
  return new THREE.Color(0x2a3c5e)
}

export const GRID_COLOR = new THREE.Color(0x2a3c5e)
