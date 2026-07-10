/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as THREE from 'three'

/** Wind speed (knots) at which a windsock flies fully horizontal. */
export const WINDSOCK_FULL_EXTENSION_SPEED = 30

export interface WindsockDimensions {
  poleHeight: number
  poleRadius: number
  sockLength: number
  sockMouthRadius: number
  sockTailRadius: number
  /** Sock colour as a THREE-compatible hex number. Defaults to white. */
  sockColor?: number
}

export interface WindsockParts {
  /** Whole windsock; rotate about world up to point the sock downwind. */
  group: THREE.Group
  /**
   * Pivot at the pole top the sock hangs from. Set `rotation.z = -droop`
   * (radians below horizontal) to droop the sock with light wind.
   */
  sockPivot: THREE.Group
}

/**
 * Droop angle (radians below horizontal) for a wind speed: a continuous linear
 * swing from `maxDroop` at calm up to horizontal at/above the full-extension
 * speed. Calibrated against the standard windsock-angle chart (fully limp at
 * 0 kt, ~45° at 15 kt, horizontal by 25–30 kt).
 */
export function windsockDroopAngle(
  speed: number,
  maxDroop: number,
  fullExtensionSpeed: number = WINDSOCK_FULL_EXTENSION_SPEED
): number {
  const extension = Math.min(Math.max(speed / fullExtensionSpeed, 0), 1)
  return (1 - extension) * maxDroop
}

/**
 * Build a windsock: a pole with a single-colour (default white) tapered sock hanging
 * from a pivot at the pole top. The sock is built pointing along +x from its
 * mouth at the pivot, so the caller can droop it (`sockPivot.rotation.z`) and
 * point it downwind (`group.rotation.y`). The caller adds the group to the
 * scene and positions it.
 */
export function buildWindsock(
  THREE: typeof import('three'),
  dimensions: WindsockDimensions
): WindsockParts {
  const {
    poleHeight,
    poleRadius,
    sockLength,
    sockMouthRadius,
    sockTailRadius,
    sockColor = 0xffffff,
  } = dimensions
  const group = new THREE.Group()

  const poleMaterial = new THREE.MeshLambertMaterial({ color: 0xd0d0d0 })
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(poleRadius, poleRadius, poleHeight, 8),
    poleMaterial
  )
  pole.position.y = poleHeight / 2
  group.add(pole)

  // Sock built pointing along +x from the origin (its mouth), so the pivot at
  // the pole top can droop it downward for lighter winds.
  const sockGeometry = new THREE.CylinderGeometry(
    sockTailRadius,
    sockMouthRadius,
    sockLength,
    16,
    1,
    true
  )
  sockGeometry.rotateZ(-Math.PI / 2) // axis from +y to +x
  sockGeometry.translate(sockLength / 2, 0, 0)
  const sockMaterial = new THREE.MeshLambertMaterial({
    color: sockColor,
    side: THREE.DoubleSide,
  })
  const sock = new THREE.Mesh(sockGeometry, sockMaterial)

  const sockPivot = new THREE.Group()
  sockPivot.position.set(0, poleHeight, 0)
  sockPivot.add(sock)
  group.add(sockPivot)

  return { group, sockPivot }
}
