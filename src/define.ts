// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { FourForcesElement } from './components/FourForces'
import { ClimbPerformanceElement } from './components/ClimbPerformance'
import { FlightPathOverviewElement } from './components/FlightPathOverview'
import { PitchRollYawElement } from './components/PitchRollYaw'

customElements.define('four-forces',          FourForcesElement)
customElements.define('climb-performance',    ClimbPerformanceElement)
customElements.define('flight-path-overview', FlightPathOverviewElement)
customElements.define('pitch-roll-yaw',       PitchRollYawElement)
