/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Parse `#rrggbbaa` / `#rrggbb` / `rgba()` into a 24-bit colour + opacity. */
export function parseColor(raw: string): { hex: number; opacity: number } {
  const trimmed = raw.trim()
  const hexMatch = trimmed.match(/^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/)
  if (hexMatch) {
    const hex = parseInt(hexMatch[1], 16)
    const opacity = hexMatch[2] === undefined ? 1 : parseInt(hexMatch[2], 16) / 255
    return { hex, opacity }
  }
  const rgbaMatch = trimmed.match(/^rgba?\(([^)]+)\)$/)
  if (rgbaMatch) {
    const parts = rgbaMatch[1].split(',').map(part => parseFloat(part.trim()))
    const [red, green, blue] = parts
    const opacity = parts.length >= 4 ? parts[3] : 1
    const hex = ((red & 0xff) << 16) | ((green & 0xff) << 8) | (blue & 0xff)
    return { hex, opacity }
  }
  // Fallback: a neutral blue so an unparseable colour still renders.
  return { hex: 0x3b82f6, opacity: 0.8 }
}
