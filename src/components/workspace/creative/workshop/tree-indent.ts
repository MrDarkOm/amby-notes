/** The left edge of a row, on the file tree's own grid: one icon-sized step per level. */
export function treeIndent(level: number): number {
  return 14 + level * 22
}
