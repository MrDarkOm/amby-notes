// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "./tooltip-provider"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("TooltipProvider", () => {
  it("dismisses a tooltip when its trigger starts an interaction", () => {
    vi.useFakeTimers()
    const { container } = render(
      <>
        <button title="Настройки">Настройки</button>
        <TooltipProvider />
      </>,
    )
    const trigger = container.querySelector("button") as HTMLButtonElement

    fireEvent.pointerOver(trigger)
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByRole("tooltip").textContent).toBe("Настройки")

    fireEvent.pointerDown(trigger)
    act(() => vi.advanceTimersByTime(300))
    expect(screen.getByRole("tooltip").style.opacity).toBe("0")
  })

  it("dismisses a tooltip when the window loses focus", () => {
    vi.useFakeTimers()
    const { container } = render(
      <>
        <button title="Поиск">Поиск</button>
        <TooltipProvider />
      </>,
    )
    const trigger = container.querySelector("button") as HTMLButtonElement

    fireEvent.pointerOver(trigger)
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByRole("tooltip").textContent).toBe("Поиск")

    fireEvent(window, new Event("blur"))
    act(() => vi.advanceTimersByTime(300))
    expect(screen.getByRole("tooltip").style.opacity).toBe("0")
  })

  it("positions tooltips at bottom by default", () => {
    vi.useFakeTimers()
    const { container } = render(
      <>
        <button id="toolbar-btn" title="Новая заметка">
          Новая
        </button>
        <TooltipProvider />
      </>,
    )

    const toolbarBtn = container.querySelector("#toolbar-btn") as HTMLButtonElement
    vi.spyOn(toolbarBtn, "getBoundingClientRect").mockReturnValue({
      left: 100,
      right: 180,
      top: 20,
      bottom: 50,
      width: 80,
      height: 30,
      x: 100,
      y: 20,
      toJSON: () => {},
    })

    fireEvent.pointerOver(toolbarBtn)
    act(() => vi.advanceTimersByTime(1000))
    const tooltip = screen.getByRole("tooltip")
    expect(tooltip.textContent).toBe("Новая заметка")
    // Top should be below the button: bottom (50) + TOOLTIP_GAP (10) = 60px
    expect(tooltip.style.top).toBe("60px")
  })

  it("respects activity-button side positioning", () => {
    vi.useFakeTimers()
    const { container } = render(
      <>
        <button
          id="activity-btn"
          className="amby-activity-button"
          data-activity-button="files"
          data-tooltip-side="right"
          title="Файлы"
        >
          Файлы
        </button>
        <TooltipProvider />
      </>,
    )

    const activityBtn = container.querySelector("#activity-btn") as HTMLButtonElement
    vi.spyOn(activityBtn, "getBoundingClientRect").mockReturnValue({
      left: 10,
      right: 42,
      top: 100,
      bottom: 132,
      width: 32,
      height: 32,
      x: 10,
      y: 100,
      toJSON: () => {},
    })

    fireEvent.pointerOver(activityBtn)
    act(() => vi.advanceTimersByTime(1000))
    const sideTooltip = screen.getByRole("tooltip")
    expect(sideTooltip.textContent).toBe("Файлы")
    // Right side: right (42) + TOOLTIP_GAP (10) = 52px
    expect(sideTooltip.style.left).toBe("52px")
  })

  it("keeps right-edge tooltips bounded within screen without overflow", () => {
    vi.useFakeTimers()
    const { container } = render(
      <>
        <button id="focus-exit-btn" title="Выйти из фокуса">
          Exit
        </button>
        <TooltipProvider />
      </>,
    )

    const btn = container.querySelector("#focus-exit-btn") as HTMLButtonElement
    // Simulate window.innerWidth = 1200
    vi.stubGlobal("innerWidth", 1200)

    vi.spyOn(btn, "getBoundingClientRect").mockReturnValue({
      left: 1160,
      right: 1188,
      top: 10,
      bottom: 38,
      width: 28,
      height: 28,
      x: 1160,
      y: 10,
      toJSON: () => {},
    })

    fireEvent.pointerOver(btn)
    act(() => vi.advanceTimersByTime(1000))
    const tooltip = screen.getByRole("tooltip")
    expect(tooltip.textContent).toBe("Выйти из фокуса")

    // Tooltip left should not push it outside the window (1200 - 12)
    const leftPx = parseFloat(tooltip.style.left)
    expect(leftPx).toBeLessThanOrEqual(1200 - 12)
    expect(leftPx).toBeGreaterThanOrEqual(12)
    expect(tooltip.style.top).toBe("48px") // 38 + 10
  })

  it("cancels pending tooltip when pointer moves away before timer fires", () => {
    vi.useFakeTimers()
    const { container } = render(
      <>
        <button id="hover-me" title="Подсказка">
          Кнопка
        </button>
        <div id="whitespace">Пусто</div>
        <TooltipProvider />
      </>,
    )

    const btn = container.querySelector("#hover-me") as HTMLButtonElement
    const whitespace = container.querySelector("#whitespace") as HTMLDivElement

    fireEvent.pointerOver(btn)
    act(() => vi.advanceTimersByTime(500))

    // Move pointer away onto whitespace before 1000ms completes
    fireEvent.pointerOut(btn, { relatedTarget: whitespace })
    act(() => vi.advanceTimersByTime(600))

    // Tooltip should never have appeared
    expect(screen.queryByRole("tooltip")).toBeNull()
  })

  it("does not show tooltip on programmatic focus when not matching :focus-visible", () => {
    vi.useFakeTimers()
    const { container } = render(
      <>
        <button id="prog-btn" title="Подсказка">
          Кнопка
        </button>
        <TooltipProvider />
      </>,
    )

    const btn = container.querySelector("#prog-btn") as HTMLButtonElement
    fireEvent.focusIn(btn)
    act(() => vi.advanceTimersByTime(1200))

    expect(screen.queryByRole("tooltip")).toBeNull()
  })
})
