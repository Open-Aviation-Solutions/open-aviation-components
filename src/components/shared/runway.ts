/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as THREE from 'three'

/** Compass heading (degrees) a runway designator points toward (e.g. "27" → 270°). */
export function runwayHeadingFromDesignator(designator: string): number {
  const leading = designator.match(/\d+/)
  const parsed = leading ? parseInt(leading[0], 10) : 27
  return (((parsed * 10) % 360) + 360) % 360
}

/** Parse a designator into its clamped number (1–36) and optional L/C/R suffix. */
function parseDesignator(designator: string): { number: number; suffix: string } {
  const parsed = designator.match(/^\s*(\d{1,2})\s*([LCRlcr]?)/)
  const number = parsed ? Math.min(Math.max(parseInt(parsed[1], 10), 1), 36) : 27
  const suffix = parsed ? parsed[2].toUpperCase() : ''
  return { number, suffix }
}

/** The painted (two-digit, upper-case) form of a designator, e.g. "9l" → "09L". */
export function normalizeDesignator(designator: string): string {
  const { number, suffix } = parseDesignator(designator)
  return String(number).padStart(2, '0') + suffix
}

/** The reciprocal designator, e.g. "27" → "09" (with L/R swapped). */
export function reciprocalDesignator(designator: string): string {
  const { number, suffix } = parseDesignator(designator)
  const reciprocalNumber = ((number + 18 - 1) % 36) + 1
  const reciprocalSuffix = suffix === 'L' ? 'R' : suffix === 'R' ? 'L' : suffix
  return String(reciprocalNumber).padStart(2, '0') + reciprocalSuffix
}

/** A canvas-textured texture for flat-on-runway labels (no background). */
export function makeTextTexture(
  THREE: typeof import('three'),
  text: string,
  color: string,
  background: string | null
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const context = canvas.getContext('2d')!
  if (background) {
    context.fillStyle = background
    context.fillRect(0, 0, canvas.width, canvas.height)
  }
  context.fillStyle = color
  context.font = 'bold 140px sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(text, canvas.width / 2, canvas.height / 2)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

export interface RunwayOptions {
  /** Runway length in metres; the surface runs from x = 0 (threshold) to +length. */
  length: number
  /** Runway width in metres. */
  width: number
  /** Designator painted at the x = 0 threshold (e.g. `27` or `09L`). */
  designator: string
  /**
   * Multiplier on the piano-key stripe length (default `1`). A close ground-level
   * view wants shorter keys so they don't swamp the near end of the runway.
   */
  keyLengthFactor?: number
  /**
   * When `true`, the dashed centreline only begins inboard of the numbers at each
   * end (realistic, and keeps the designator legible from close up). Default
   * `false` keeps the centreline running the full length.
   */
  centrelineAfterNumber?: boolean
}

/**
 * Build a runway group: grey surface from the threshold (x = 0) toward +x,
 * dashed centreline, and threshold markings at both ends — "piano keys"
 * (longitudinal white bars across the width) followed, further in, by the
 * runway designator. The x = 0 end carries the named runway (landing toward
 * +x); the far end carries its reciprocal (`27` → `09`, `L`/`R` swapped).
 * Each number is rotated so it reads upright to a pilot standing at that
 * threshold. The caller adds the group to the scene.
 */
export function buildRunwayGroup(
  THREE: typeof import('three'),
  options: RunwayOptions
): THREE.Group {
  const group = new THREE.Group()
  const { length, width, designator, keyLengthFactor, centrelineAfterNumber } = options

  // Runway surface — extends from the threshold (x = 0) toward the rollout (+x).
  const surfaceGeometry = new THREE.PlaneGeometry(length, width)
  const surfaceMaterial = new THREE.MeshLambertMaterial({ color: 0x3a3a3f })
  const surface = new THREE.Mesh(surfaceGeometry, surfaceMaterial)
  surface.rotation.x = -Math.PI / 2
  surface.position.set(length / 2, 0, 0)
  group.add(surface)

  // Threshold-marking metrics (piano keys + designator). Defined up front so the
  // centreline can be held back past the numbers when requested.
  const designatorSize = Math.min(width * 0.9, length * 0.12)
  const keyInset = length * 0.015
  const keyLength = Math.min(length * 0.05, 80) * (keyLengthFactor ?? 1)
  const numberGap = length * 0.02
  // Inboard edge of the threshold markings (the far edge of the designator).
  const markingsEnd = keyInset + keyLength + numberGap + designatorSize

  // Dashed white centreline, slightly above the surface. Optionally held back so
  // it only starts past the runway number at each end.
  const dashLength = 30
  const gapLength = 20
  const centrelineStart = centrelineAfterNumber ? markingsEnd + gapLength : dashLength
  const centrelineStop = centrelineAfterNumber ? length - markingsEnd - gapLength : length - dashLength
  const centrelineMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff })
  for (let x = centrelineStart; x < centrelineStop; x += dashLength + gapLength) {
    const dash = new THREE.Mesh(new THREE.PlaneGeometry(dashLength, width * 0.04), centrelineMaterial)
    dash.rotation.x = -Math.PI / 2
    dash.position.set(x + dashLength / 2, 0.1, 0)
    group.add(dash)
  }

  const ends = [
    { thresholdX: 0, inward: 1, text: normalizeDesignator(designator) },
    { thresholdX: length, inward: -1, text: reciprocalDesignator(designator) },
  ]

  for (const end of ends) {
    // Piano-key threshold stripes.
    const stripeCount = 8
    const stripeSpan = width * 0.85
    const stripeUnit = stripeSpan / (stripeCount * 2 - 1) // equal stripe + gap widths
    const keysCenterX = end.thresholdX + end.inward * (keyInset + keyLength / 2)
    for (let stripe = 0; stripe < stripeCount; stripe++) {
      const z = -stripeSpan / 2 + stripeUnit / 2 + stripe * 2 * stripeUnit
      const key = new THREE.Mesh(new THREE.PlaneGeometry(keyLength, stripeUnit), centrelineMaterial)
      key.rotation.x = -Math.PI / 2
      key.position.set(keysCenterX, 0.1, z)
      group.add(key)
    }

    // Runway designator, sized to sit within the pavement.
    const designatorTexture = makeTextTexture(THREE, end.text, '#ffffff', null)
    const designatorMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(designatorSize, designatorSize),
      new THREE.MeshBasicMaterial({ map: designatorTexture, transparent: true })
    )
    designatorMesh.rotation.x = -Math.PI / 2
    // Top of the digits points down the runway (toward the far end), so the
    // number reads upright to a pilot standing at this threshold.
    designatorMesh.rotation.z = end.inward > 0 ? -Math.PI / 2 : Math.PI / 2
    const numberCenterX =
      end.thresholdX + end.inward * (keyInset + keyLength + numberGap + designatorSize / 2)
    designatorMesh.position.set(numberCenterX, 0.12, 0)
    group.add(designatorMesh)
  }

  return group
}
