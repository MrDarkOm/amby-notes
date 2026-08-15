"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { parseIconValue } from "./icon-values"

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
    return <Icon aria-hidden="true" className={cn("size-5", className)} style={{ color }} />
  }
  return <>{value || fallback}</>
}
