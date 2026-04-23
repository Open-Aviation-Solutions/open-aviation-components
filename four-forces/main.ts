import '../demo/shared.css'
import { renderSidebar } from '../demo/sidebar'
import '../src/components/FourForces'

renderSidebar('four-forces')

const toggle = document.getElementById('banking-toggle') as HTMLInputElement
const element = document.querySelector('four-forces')!
toggle.addEventListener('change', () => {
  if (toggle.checked) element.setAttribute('banking', '')
  else element.removeAttribute('banking')
})
