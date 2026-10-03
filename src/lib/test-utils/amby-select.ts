import { expect } from "vitest"
import { fireEvent, screen, waitFor } from "@testing-library/react"

/** Opens the drop-down list named `name` and picks the option with the given text. */
export async function chooseOption(name: string | RegExp, option: string | RegExp) {
  // A list that was just used may still be closing; start from none open.
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull(), { timeout: 3000 })
  const trigger = await screen.findByRole("combobox", { name })
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false), {
    timeout: 3000,
  })
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole("option", { name: option }, { timeout: 3000 }))
}

/** The text of the choice a drop-down list currently shows. */
export function selectedText(name: string | RegExp): string {
  return screen.getByRole("combobox", { name }).textContent ?? ""
}
