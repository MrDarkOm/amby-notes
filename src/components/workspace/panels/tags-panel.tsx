"use client"

import { SidebarTags } from "../sidebar-tags"
import type { PanelRenderProps } from "../panel-registry"

export function TagsPanel({ treeItems, onSelect, readFile, vault }: PanelRenderProps) {
  return <SidebarTags items={treeItems} onSelect={onSelect} readFile={readFile} vault={vault} />
}
