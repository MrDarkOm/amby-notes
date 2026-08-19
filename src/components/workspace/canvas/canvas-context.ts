import * as React from "react"

export interface CanvasCtxValue {
  vault: string | null
  onOpenNote?: (file: string) => void
  updateNodeData: (id: string, patch: Record<string, unknown>) => void
}

export const CanvasCtx = React.createContext<CanvasCtxValue>({
  vault: null,
  updateNodeData: () => {},
})

export const useCanvasCtx = () => React.useContext(CanvasCtx)
