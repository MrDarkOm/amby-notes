import { describe, expect, it } from "vitest"
import type { TFunction } from "i18next"
import {
  createProcessTemplate,
  createTopicMapTemplate,
  createProjectOverviewTemplate,
} from "./canvas-templates"

const mockT = ((key: string) => key) as unknown as TFunction

describe("canvas-templates", () => {
  it("creates a process template with 4 steps and 3 edges", () => {
    const res = createProcessTemplate({ x: 0, y: 0 }, mockT)
    expect(res.nodes).toHaveLength(4)
    expect(res.edges).toHaveLength(3)
    expect(res.edges[0].source).toBe(res.nodes[0].id)
    expect(res.edges[0].target).toBe(res.nodes[1].id)
  })

  it("creates a topic map template with central node and 4 satellites", () => {
    const res = createTopicMapTemplate({ x: 100, y: 100 }, mockT)
    expect(res.nodes).toHaveLength(5)
    expect(res.edges).toHaveLength(4)
    // All 4 edges start from the center node
    const centerId = res.nodes[0].id
    for (const e of res.edges) {
      expect(e.source).toBe(centerId)
    }
  })

  it("creates a project overview template with 3 groups and cards", () => {
    const res = createProjectOverviewTemplate({ x: 0, y: 0 }, mockT)
    const groups = res.nodes.filter((n) => n.type === "group")
    expect(groups).toHaveLength(3)
    expect(res.nodes.length).toBeGreaterThanOrEqual(6)
  })
})
