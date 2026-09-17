"use client"

import { HelpModal, type HelpModalProps } from "../help-modal"

export type CanvasHelpModalProps = HelpModalProps

export function CanvasHelpModal(props: CanvasHelpModalProps) {
  return <HelpModal initialContext="canvas" {...props} />
}
