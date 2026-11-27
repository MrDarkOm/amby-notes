import { describe, expect, it } from "vitest"
import { renderChatMarkdown } from "./chat-markdown"

describe("AI response Markdown", () => {
  // AI1-U2: render useful formatting without trusting model output.
  it("renders lists and code while escaping HTML and refusing unsafe links and images", () => {
    const result = renderChatMarkdown(
      "- **item**\n\n```js\nalert(1)\n```\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1)) ![remote](https://example.com/a.png) [good](https://example.com)",
    )
    expect(result).toContain("<ul>")
    expect(result).toContain("<strong>item</strong>")
    expect(result).toContain("<pre><code")
    expect(result).not.toContain("<script>")
    expect(result).not.toContain("<img")
    expect(result).not.toContain('href="javascript:')
    expect(result).toContain('href="https://example.com"')
  })

  it("allows relative note links but rejects encoded unsafe schemes and traversal", () => {
    const result = renderChatMarkdown(
      "[note](My%20Note.md) [bad](javascript%3Aalert) [outside](../secret.md)",
    )
    expect(result).toContain('href="My%20Note.md"')
    expect(result).not.toContain('href="javascript')
    expect(result).not.toContain('href="../secret.md"')
  })
})
