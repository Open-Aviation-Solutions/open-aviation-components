/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as THREE from 'three'

/**
 * Unit horizontal vector for the direction the wind blows *toward*, in world
 * space, for a scene whose +x axis points along the reference compass heading
 * (e.g. the runway heading). Uses the verified bearing→world mapping: bearing
 * `referenceHeading` is `+x`, and each degree clockwise rotates
 * `(cos Δ, 0, sin Δ)` with `Δ = bearing − referenceHeading`.
 */
export function worldWindToward(
  THREE: typeof import('three'),
  windFromDegrees: number,
  referenceHeadingDegrees: number
): THREE.Vector3 {
  const delta = (windFromDegrees + 180 - referenceHeadingDegrees) * (Math.PI / 180)
  return new THREE.Vector3(Math.cos(delta), 0, Math.sin(delta))
}

/**
 * Rotation about world up (+y, radians) that points an object built facing +x
 * toward the compass bearing the wind blows *toward* (`windFrom + 180`), in the
 * same +x-along-`referenceHeading` frame. Negated because compass bearings
 * increase clockwise while a positive rotation about +y is anticlockwise
 * (looking down) — so +z reads as north relative to the reference heading.
 */
export function windsockYawRotation(
  windFromDegrees: number,
  referenceHeadingDegrees: number
): number {
  const windToward = windFromDegrees + 180
  return -(windToward - referenceHeadingDegrees) * (Math.PI / 180)
}
