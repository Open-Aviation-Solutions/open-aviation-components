/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { describe, expect, it } from 'vitest'
import { MIN_PLOT_W, VMAX_NORM, VS_NORM, powerRequired, sideBySidePlotWidth, thrustRequired } from './index'

describe('origin line on the power chart', () => {
  it('has a slope equal to the drag (thrust required) at every speed on the chart', () => {
    const steps = 100
    for (let step = 0; step <= steps; step++) {
      const speed = VS_NORM + (step / steps) * (VMAX_NORM - VS_NORM)
      expect(powerRequired(speed) / speed).toBeCloseTo(thrustRequired(speed), 12)
    }
  })
})

describe('layout breakpoint', () => {
  it('stacks the charts below a 634 px wide canvas, where each would be narrower than MIN_PLOT_W', () => {
    expect(sideBySidePlotWidth(633)).toBeLessThan(MIN_PLOT_W)
    expect(sideBySidePlotWidth(634)).toBeGreaterThanOrEqual(MIN_PLOT_W)
  })
})
