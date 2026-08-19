"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

export interface WorkspaceShellProps {
  children: React.ReactNode
  className?: string
}

export function WorkspaceShell({ children, className }: WorkspaceShellProps) {
  return (
    <div
      className={cn(
        "relative flex h-screen w-screen select-none flex-col overflow-hidden bg-background text-foreground",
        className,
      )}
    >
      {children}
    </div>
  )
}
