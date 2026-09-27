"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

export interface ToolbarButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  title: string
  active?: boolean
  disabled?: boolean
  children: React.ReactNode
  className?: string
  onMouseDown?: (e: React.MouseEvent<HTMLButtonElement>) => void
}

export function ToolbarButton({
  title,
  onClick,
  active,
  disabled,
  children,
  className,
  onMouseDown,
  ...props
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      onMouseDown={onMouseDown}
      {...props}
      className={cn(
        "flex size-7 items-center justify-center rounded-lg select-none",
        active
          ? "bg-primary text-primary-foreground shadow-2xs font-medium"
          : "text-foreground hover:bg-accent hover:text-accent-foreground",
        disabled && "opacity-40 cursor-not-allowed hover:bg-transparent",
        className,
      )}
    >
      {children}
    </button>
  )
}
