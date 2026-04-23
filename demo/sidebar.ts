interface NavEntry {
  slug: string
  label: string
  href: string
}

const NAV: NavEntry[] = [
  { slug: 'four-forces', label: 'Four Forces', href: '/open-aviation-components/four-forces/' },
]

export function renderSidebar(activeSlug: string | null): void {
  const container = document.getElementById('sidebar')!
  container.innerHTML = `
    <div class="sidebar-header">
      <a href="/open-aviation-components/" class="sidebar-title">Open Aviation<br>Components</a>
    </div>
    <ul>
      ${NAV.map(item => `
        <li><a href="${item.href}" class="${item.slug === activeSlug ? 'active' : ''}">${item.label}</a></li>
      `).join('')}
    </ul>
    <div class="sidebar-footer">
      <a href="https://github.com/open-aviation-solutions/open-aviation-components" target="_blank" rel="noopener">GitHub</a>
    </div>
  `
}
