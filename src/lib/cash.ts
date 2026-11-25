/** Over/short against the tolerance setting. Within tolerance (inclusive) needs no note; past it, a note is required. */
export function overShortStatus(counted: number, expected: number, tolerance: number) {
  const diff = counted - expected
  return { diff, within: Math.abs(diff) <= tolerance }
}
