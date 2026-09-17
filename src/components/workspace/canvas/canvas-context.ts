import * as React from "react"

export interface CanvasCtxValue {
  vault: string | null
  onOpenNote?: (file: string) => void
  updateNodeData: (id: string, patch: Record<string, unknown>) => void
  setEdgeLabel?: (id: string, label: string) => void
  isLocked?: boolean
  connectorMode?: boolean
}

export const CanvasCtx = React.createContext<CanvasCtxValue>({
  vault: null,
  updateNodeData: () => {},
  setEdgeLabel: () => {},
  isLocked: false,
  connectorMode: false,
})

export const useCanvasCtx = () => React.useContext(CanvasCtx)
