// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { FourForcesElement } from './components/FourForces'
import { ClimbPerformanceElement } from './components/ClimbPerformance'
import { BriefingOverviewElement } from './components/BriefingOverview'
import { PitchRollYawElement } from './components/PitchRollYaw'
import { AerofoilDynamicsElement } from './components/AerofoilDynamics'
import { CircuitDiagramElement } from './components/CircuitDiagram'

customElements.define('four-forces',          FourForcesElement)
customElements.define('climb-performance',    ClimbPerformanceElement)
customElements.define('briefing-overview',    BriefingOverviewElement)
customElements.define('pitch-roll-yaw',       PitchRollYawElement)
customElements.define('aerofoil-dynamics',    AerofoilDynamicsElement)
customElements.define('circuit-diagram',      CircuitDiagramElement)
