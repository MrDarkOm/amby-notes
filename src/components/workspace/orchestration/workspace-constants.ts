import type { ContentWidth } from "../app-config"

export const databaseContentWidthKey = (databaseId: string) => `database:${databaseId}`
export const EMPTY_CONTENT_WIDTHS: Record<string, ContentWidth> = {}
export const EMPTY_DATABASE_TITLE_LABELS: Record<string, string> = {}
export const EMPTY_LAYERS = { canvas: false, sketch: false, database: false }
export const NOOP = () => {}
