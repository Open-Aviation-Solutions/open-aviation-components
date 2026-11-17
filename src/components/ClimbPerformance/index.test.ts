/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { describe, expect, it } from 'vitest'
import { VMAX_NORM, VS_NORM, originLineSlope, thrustRequired } from './index'

describe('origin line on the power chart', () => {
  it('has a slope equal to the drag (thrust required) at every speed on the chart', () => {
    const steps = 100
    for (let i = 0; i <= steps; i++) {
      const speed = VS_NORM + (i / steps) * (VMAX_NORM - VS_NORM)
      expect(originLineSlope(speed)).toBeCloseTo(thrustRequired(speed), 12)
    }
  })
})
