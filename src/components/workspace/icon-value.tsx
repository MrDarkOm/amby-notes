"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { parseIconValue } from "./icon-values"
import { KNOWN_ICONS } from "./tree/tree-types"

export function IconValue({
  value,
  fallback,
  className,
}: {
  value?: string
  fallback?: React.ReactNode
  className?: string
}) {
  if (value && /^data:image\/(?:png|jpeg|webp);base64,/u.test(value)) {
    return (
      <img
        src={value}
        alt=""
        className={cn("size-5 rounded object-cover", className)}
        draggable={false}
      />
    )
  }
  const parsed = parseIconValue(value)
  if (parsed) {
    const { Icon, color } = parsed
    return (
      <Icon
        aria-hidden="true"
        className={cn("size-5", className)}
        style={{ color }}
        data-amby-icon-color={color ? color.toLowerCase() : undefined}
      />
    )
  }
  if (value && KNOWN_ICONS.has(value)) {
    return <>{fallback}</>
  }
  if (value) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex items-center justify-center leading-none select-none text-[13px]",
          className,
        )}
      >
        {value}
      </span>
    )
  }
  return <>{fallback}</>
}
