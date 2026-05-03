"use client"

import * as React from "react"
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  MoreVertical,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"

interface Document {
  id: string
  title: string
  content: string
  modified: string
  wordCount: number
}

interface DocumentEditorProps {
  document: Document | null
  onContentChange?: (content: string) => void
}

// Custom brain/split circle icon matching the Figma design
function BrainIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 3V21" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 7C14.5 7 17 9 17 12C17 15 14.5 17 12 17" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

export function DocumentEditor({ document, onContentChange }: DocumentEditorProps) {
  const [content, setContent] = React.useState(document?.content || "")

  React.useEffect(() => {
    setContent(document?.content || "")
  }, [document])

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value)
    onContentChange?.(e.target.value)
  }

  if (!document) {
    return (
      <div className="flex h-full flex-1 flex-col bg-background">
        {/* Empty state nav bar */}
        <div className="flex h-9 items-center justify-between border-b border-zinc-800 bg-[#0A0A0A] px-2">
          <div className="flex items-center gap-0.5">
            <Button variant="ghost" size="icon" className="size-7 text-zinc-500" disabled>
              <ChevronLeft className="size-4" />
            </Button>
            <Button variant="ghost" size="icon" className="size-7 text-zinc-500" disabled>
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center text-zinc-500">
          Select a document to start editing
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-1 flex-col bg-background">
      {/* Editor Navigation Bar */}
      <div className="flex h-9 items-center justify-between border-b border-zinc-800 bg-[#0A0A0A] px-2">
        {/* Left Side: Back/Forward Navigation */}
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon" className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white">
            <ChevronLeft className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white">
            <ChevronRight className="size-4" />
          </Button>
        </div>

        {/* Center: Breadcrumbs */}
        <div className="flex items-center gap-1.5 text-xs">
          <button className="text-zinc-500 transition-colors hover:text-zinc-300">Main</button>
          <span className="text-zinc-600">/</span>
          <button className="text-zinc-500 transition-colors hover:text-zinc-300">Projects</button>
          <span className="text-zinc-600">/</span>
          <span className="text-zinc-300">{document.title}</span>
        </div>

        {/* Right Side: View Controls */}
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon" className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white">
            <BookOpen className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white">
            <Maximize2 className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white">
            <MoreVertical className="size-4" />
          </Button>
        </div>
      </div>

      {/* Editor Content */}
      <ScrollArea className="flex-1">
        <div className="px-10 py-8">
          {/* Title with brain icon */}
          <div className="mb-4 flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg border border-zinc-800">
              <BrainIcon className="size-5 text-zinc-400" />
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-zinc-100">{document.title}</h1>
          </div>

          {/* Metadata - smaller and more muted */}
          <div className="mb-6 flex items-center gap-3 text-[11px] uppercase tracking-wider text-zinc-500">
            <span className="font-medium">Modified</span>
            <span>{document.modified}</span>
            <span className="text-zinc-700">-</span>
            <span>{document.wordCount} words</span>
          </div>

          {/* Divider */}
          <div className="mb-6 h-px bg-zinc-800" />

          {/* Content Editor */}
          <textarea
            value={content}
            onChange={handleContentChange}
            placeholder="Start writing your thoughts..."
            className="min-h-[400px] w-full resize-none bg-transparent text-base leading-relaxed text-zinc-300 placeholder:text-zinc-600 focus:outline-none"
          />
        </div>
      </ScrollArea>
    </div>
  )
}
