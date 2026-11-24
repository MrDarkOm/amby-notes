import { createLucideIcon } from "lucide-react"

/** Two tabs on the top edge of a note, one opening into the visible page. */
export const NotePagesIcon = createLucideIcon({
  name: "note-pages",
  size: 24,
  node: [
    [
      "path",
      {
        d: "M3 6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
        key: "page",
      },
    ],
    ["path", { d: "M14 5h5a2 2 0 0 1 2 2v3M7 15h6", key: "tab-and-text" }],
  ],
})
