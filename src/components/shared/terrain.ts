/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as THREE from 'three'

// ---- procedural terrain helpers ------------------------------------------
// All deterministic: the same seed always yields the same landscape (no use of
// Math.random), so embeds are stable and presenter/slide pairs stay in sync.

/** Plane subdivisions per side for the terrain mesh (resolution vs. cost). */
export const TERRAIN_SEGMENTS = 160
/** Horizontal feature size of the base terrain noise, in metres. */
export const TERRAIN_FEATURE_SIZE = 900
/** Surface height (world units) of carved water bodies. */
export const TERRAIN_WATER_LEVEL = -28

/** Hash an arbitrary seed string into a 32-bit unsigned integer (xmur3). */
export function hashSeed(text: string): number {
  let hash = 1779033703 ^ text.length
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 3432918353)
    hash = (hash << 13) | (hash >>> 19)
  }
  hash = Math.imul(hash ^ (hash >>> 16), 2246822507)
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909)
  return (hash ^ (hash >>> 16)) >>> 0
}

/** Deterministic [0,1) hash of an integer grid cell, mixed with the seed. */
function hashCell(cellX: number, cellZ: number, seed: number): number {
  let hash = Math.imul(cellX | 0, 374761393) ^ Math.imul(cellZ | 0, 668265263) ^ seed
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177)
  hash = (hash ^ (hash >>> 16)) >>> 0
  return hash / 4294967296
}

const smootherStep = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

export const lerpScalar = (a: number, b: number, t: number) => a + (b - a) * t

/** Smooth interpolation from 0 (at edge0) to 1 (at edge1). */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** 2-D value noise in [-1, 1] for a continuous position, seeded. */
export function valueNoise(x: number, z: number, seed: number): number {
  const cellX = Math.floor(x)
  const cellZ = Math.floor(z)
  const tx = smootherStep(x - cellX)
  const tz = smootherStep(z - cellZ)
  const v00 = hashCell(cellX, cellZ, seed)
  const v10 = hashCell(cellX + 1, cellZ, seed)
  const v01 = hashCell(cellX, cellZ + 1, seed)
  const v11 = hashCell(cellX + 1, cellZ + 1, seed)
  const top = lerpScalar(v00, v10, tx)
  const bottom = lerpScalar(v01, v11, tx)
  return lerpScalar(top, bottom, tz) * 2 - 1
}

/** Fractal Brownian motion: summed octaves of value noise, rotated per octave. */
export function fbm(x: number, z: number, seed: number, octaves: number): number {
  let amplitude = 1
  let sum = 0
  let norm = 0
  let sampleX = x
  let sampleZ = z
  for (let octave = 0; octave < octaves; octave++) {
    sum += amplitude * valueNoise(sampleX, sampleZ, seed + octave * 1013)
    norm += amplitude
    amplitude *= 0.5
    // Rotate (~10°) and scale (~1.97×) for the next octave to break up the
    // axis-aligned look of raw value noise.
    const rotatedX = sampleX * 1.94 + sampleZ * 0.34
    const rotatedZ = -sampleX * 0.34 + sampleZ * 1.94
    sampleX = rotatedX
    sampleZ = rotatedZ
  }
  return sum / norm
}

/** Elevation → colour ramp anchors (world height → RGB 0–255). */
const TERRAIN_RAMP: ReadonlyArray<{ height: number; color: [number, number, number] }> = [
  { height: TERRAIN_WATER_LEVEL, color: [0x2a, 0x4d, 0x69] }, // water
  { height: 4, color: [0x6e, 0x8c, 0x55] }, // shoreline / lowland
  { height: 80, color: [0x4d, 0x70, 0x40] }, // grass / forest
  { height: 230, color: [0x6d, 0x61, 0x4d] }, // rock
  { height: 370, color: [0x8c, 0x84, 0x73] }, // high rock
  { height: 520, color: [0xed, 0xf1, 0xf5] }, // snow
]

/** Sample the terrain colour ramp at a height, returned as linear-ish 0–1 RGB. */
function rampColor(height: number): [number, number, number] {
  if (height <= TERRAIN_RAMP[0].height) {
    const [r, g, b] = TERRAIN_RAMP[0].color
    return [r / 255, g / 255, b / 255]
  }
  for (let index = 1; index < TERRAIN_RAMP.length; index++) {
    const upper = TERRAIN_RAMP[index]
    if (height <= upper.height) {
      const lower = TERRAIN_RAMP[index - 1]
      const t = (height - lower.height) / (upper.height - lower.height)
      return [
        lerpScalar(lower.color[0], upper.color[0], t) / 255,
        lerpScalar(lower.color[1], upper.color[1], t) / 255,
        lerpScalar(lower.color[2], upper.color[2], t) / 255,
      ]
    }
  }
  const [r, g, b] = TERRAIN_RAMP[TERRAIN_RAMP.length - 1].color
  return [r / 255, g / 255, b / 255]
}

export interface TerrainOptions {
  /** Side length (metres) of the square terrain plane. */
  span: number
  /** Seed string; the same seed always yields the same landscape. */
  seedText: string
  /** Multiplier on the terrain height / amplitude. */
  roughness: number
  /**
   * Flat clearing held under the airfield: perfectly flat out to `innerRadius`
   * from (`centerX`, `centerZ`), ramping up to full terrain by `outerRadius`.
   */
  clearing: { centerX: number; centerZ: number; innerRadius: number; outerRadius: number }
  /** Plane subdivisions per side (default `TERRAIN_SEGMENTS`). */
  segments?: number
}

/**
 * Build the procedural landscape mesh: a subdivided plane displaced by seeded
 * fractal value noise, flat under the airfield clearing, with gentle hills near
 * the field growing into mountains with distance, lakes carved below
 * `TERRAIN_WATER_LEVEL`, and vertices coloured by elevation. The caller adds it
 * to the scene (and offsets its `position.y` slightly below the runway to avoid
 * z-fighting).
 */
export function buildTerrainMesh(
  THREE: typeof import('three'),
  options: TerrainOptions
): THREE.Mesh {
  const { span, seedText, roughness, clearing } = options
  const segments = options.segments ?? TERRAIN_SEGMENTS

  const geometry = new THREE.PlaneGeometry(span, span, segments, segments)
  geometry.rotateX(-Math.PI / 2) // lie flat: vertices now span world X/Z, normal +y

  const seed = hashSeed(seedText)
  const { centerX, centerZ, innerRadius, outerRadius } = clearing

  // Gentle hills near the field grow into mountains by farRadius.
  const farRadius = span * 0.48
  const gentleAmplitude = 70 * roughness
  const mountainAmplitude = 620 * roughness

  const position = geometry.attributes.position as THREE.BufferAttribute
  const colors: number[] = []
  for (let index = 0; index < position.count; index++) {
    const x = position.getX(index)
    const z = position.getZ(index)
    const distance = Math.hypot(x - centerX, z - centerZ)

    const noise = fbm(x / TERRAIN_FEATURE_SIZE, z / TERRAIN_FEATURE_SIZE, seed, 5)
    const distantness = smoothstep(outerRadius, farRadius, distance)
    const amplitude = lerpScalar(gentleAmplitude, mountainAmplitude, distantness)
    // Lift distant ground a little so mountains mostly rise above the plain.
    let height = noise * amplitude + distantness * 60
    height *= smoothstep(innerRadius, outerRadius, distance) // flatten the clearing
    if (height < TERRAIN_WATER_LEVEL) height = TERRAIN_WATER_LEVEL // carve flat lakes

    position.setY(index, height)
    const [r, g, b] = rampColor(height)
    colors.push(r, g, b)
  }
  position.needsUpdate = true
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.computeVertexNormals()

  const material = new THREE.MeshLambertMaterial({ vertexColors: true })
  return new THREE.Mesh(geometry, material)
}

/** A plain flat green ground plane (the `show-terrain="false"` fallback). */
export function buildFlatGroundMesh(THREE: typeof import('three'), span: number): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(span, span)
  const material = new THREE.MeshLambertMaterial({ color: 0x4b7a4b })
  const ground = new THREE.Mesh(geometry, material)
  ground.rotation.x = -Math.PI / 2
  return ground
}
