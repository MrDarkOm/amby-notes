import MarkdownIt from "markdown-it"

// Model output is untrusted: do not execute HTML or load remote images.
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })
markdown.validateLink = (url) => {
  if (/^https?:\/\//i.test(url)) return true
  try {
    const decoded = decodeURIComponent(url)
    return (
      !!decoded &&
      !/[:\\]/u.test(decoded) &&
      !Array.from(decoded).some((character) => character.charCodeAt(0) < 32) &&
      !decoded.startsWith("/") &&
      !decoded.split("/").includes("..")
    )
  } catch {
    return false
  }
}
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content)

export function renderChatMarkdown(text: string): string {
  return markdown.render(text)
}
