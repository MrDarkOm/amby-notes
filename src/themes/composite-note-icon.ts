import { createLucideIcon } from "lucide-react"

/** A bundle: one sheet with a ribbon bookmark and section tabs along its edge. */
export const CompositeNoteIcon = createLucideIcon({
  name: "composite-note",
  size: 24,
  node: [
    ["rect", { x: "3", y: "3", width: "15", height: "18", rx: "2", key: "sheet" }],
    ["path", { d: "M10 3v7l2.5-2 2.5 2V3", key: "ribbon" }],
    [
      "path",
      {
        d: "M18 6h2a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-2M18 13h2a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-2",
        key: "tabs",
      },
    ],
    ["path", { d: "M7 13h7M7 17h4", key: "lines" }],
  ],
})
