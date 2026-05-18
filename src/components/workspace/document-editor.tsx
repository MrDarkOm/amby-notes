"use client";

import * as React from "react";
import {
  Code2,
  Database,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileText,
  FilePlus,
  FolderOpen,
  LayoutGrid,
  Lock,
  Maximize2,
  Minimize2,
  MoreVertical,
  Redo2,
  PenLine,
  Undo2,
} from "lucide-react";
import { SourceEditor } from "./source-editor";
import { TiptapEditor } from "./tiptap/TiptapEditor";
import type { EditorHandle } from "./tiptap/constants";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";

import { Button } from "@/components/ui/button";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@/lib/storage";
import { EmojiPickerPanel } from "./tiptap/EmojiPickerPanel";

interface Document {
  id: string;
  title: string;
  content: string;
  modified: string;
  wordCount: number;
  path: string;
}

interface DocumentEditorProps {
  document: Document | null;
  onContentChange?: (content: string) => void;
  onBack?: () => void;
  onForward?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onRenameTitle?: (newName: string) => void;
  vault?: string;
  isFocusMode?: boolean;
  onToggleFocusMode?: () => void;
  fileIcon?: string;
  onNewFile?: () => void;
  onOpenVault?: () => void;
  onTagClick?: (tag: string) => void;
  onWikiLinkClick?: (target: string) => void;
  activeLayer?: EditorLayer;
  onLayerChange?: (layer: EditorLayer) => void;
  viewMode?: DocumentViewMode;
  onViewModeChange?: (mode: DocumentViewMode) => void;
  onFileIconChange?: (emoji: string) => void;
  linkedLayers?: { canvas: boolean; sketch: boolean; database: boolean };
  isLocked?: boolean;
  onToggleLock?: () => void;
}

type EditorLayer = "editor" | "canvas" | "database" | "sketch";
export type DocumentViewMode = "source" | "live" | "read";

const LAYER_OPTIONS: Array<{
  id: EditorLayer;
  label: string;
  icon: React.ElementType;
  title: string;
}> = [
  { id: "editor", label: "Editor", icon: FileText, title: "Markdown editor" },
  { id: "canvas", label: "Canvas", icon: LayoutGrid, title: "Canvas layer" },
  {
    id: "database",
    label: "Database",
    icon: Database,
    title: "Database layer",
  },
  { id: "sketch", label: "Sketch", icon: PenLine, title: "Sketch layer" },
];

function getRelativePath(vault: string | undefined, filePath: string): string {
  if (!vault || !filePath) return "";
  const norm = (p: string) => p.replace(/\\/g, "/");
  const rel = norm(filePath).startsWith(norm(vault) + "/")
    ? norm(filePath).slice(norm(vault).length + 1)
    : (norm(filePath).split("/").pop() ?? norm(filePath));
  return rel.split("/").join(" › ");
}

function handleDragStart(e: React.MouseEvent) {
  if (e.button !== 0) return;
  if (isTauri()) {
    e.preventDefault();
    getCurrentWindow()
      .startDragging()
      .catch(() => {});
  }
}

export function DocumentEditor({
  document,
  onContentChange,
  onBack,
  onForward,
  canGoBack = false,
  canGoForward = false,
  onRenameTitle,
  vault,
  isFocusMode = false,
  onToggleFocusMode,
  fileIcon,
  onNewFile,
  onOpenVault,
  onTagClick,
  onWikiLinkClick,
  activeLayer = "editor",
  onLayerChange,
  viewMode = "live",
  onViewModeChange,
  onFileIconChange,
  linkedLayers,
  isLocked = false,
  onToggleLock,
}: DocumentEditorProps) {
  const [content, setContent] = React.useState(document?.content ?? "");
  const [editingTitle, setEditingTitle] = React.useState(false);
  const [titleValue, setTitleValue] = React.useState(document?.title ?? "");
  const [emojiPickerOpen, setEmojiPickerOpen] = React.useState(false);
  const [layerConfirm, setLayerConfirm] = React.useState<EditorLayer | null>(null);
  const editorRef = React.useRef<EditorHandle>(null as unknown as EditorHandle);
  const titleInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    setContent(document?.content ?? "");
    setTitleValue(document?.title ?? "");
    setEditingTitle(false);
  }, [document?.id]);

  React.useEffect(() => {
    if (editingTitle)
      setTimeout(() => {
        titleInputRef.current?.select();
        titleInputRef.current?.focus();
      }, 0);
  }, [editingTitle]);

  function commitTitleRename() {
    const trimmed = titleValue.trim();
    if (trimmed && trimmed !== document?.title) onRenameTitle?.(trimmed);
    setEditingTitle(false);
  }

  function handleTitleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") commitTitleRename();
    if (e.key === "Escape") {
      setTitleValue(document?.title ?? "");
      setEditingTitle(false);
    }
  }

  const handleContentChange = (v: string) => {
    setContent(v);
    onContentChange?.(v);
  };

  const relPath = document ? getRelativePath(vault, document.path) : "";

  const layerLabelRu: Record<string, string> = {
    canvas: "Canvas",
    database: "базу данных",
    sketch: "Excalidraw",
  };

  const navBar = (
    <>
    <div
      className={`flex h-9 shrink-0 items-center justify-between border-zinc-800 px-2 ${isFocusMode ? "bg-[#0A0A0A]/80 backdrop-blur-sm" : "bg-[#0A0A0A]"}`}
    >
      {/* Left: back/forward + drag zone for focus mode */}
      <div className="flex items-center gap-0.5">
        {isFocusMode && (
          <div
            className="w-6 h-9 cursor-default"
            onMouseDown={handleDragStart}
          />
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white disabled:opacity-30"
          onClick={onBack}
          disabled={!canGoBack}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white disabled:opacity-30"
          onClick={onForward}
          disabled={!canGoForward}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      {/* Center: path */}
      <div className="flex flex-1 items-center justify-center gap-1.5 overflow-hidden px-2 text-xs">
        {relPath ? (
          <span className="truncate text-zinc-500">{relPath}</span>
        ) : document ? (
          <span className="text-zinc-400">{document.title}</span>
        ) : null}
      </div>

      {/* Right: layer + focus + more */}
      <div className="flex items-center gap-0.5">
        {document && (
          <div className="mr-1 flex items-center rounded bg-zinc-950 p-0.5 gap-1">
            {/* Editor layer — always visible */}
            <button
              type="button"
              title="Markdown editor"
              onClick={() => onLayerChange?.("editor")}
              className={`flex size-6 items-center justify-center rounded transition-colors ${
                activeLayer === "editor"
                  ? "bg-zinc-800 text-zinc-100"
                  : "bg-zinc-1000 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
              }`}
            >
              <FileText className="size-3.5" />
            </button>
            {/* Only show attached (linked) layers */}
            {linkedLayers?.canvas && (
              <button
                type="button"
                title="Canvas layer"
                onClick={() => onLayerChange?.("canvas")}
                className={`flex size-6 items-center justify-center rounded transition-colors ${
                  activeLayer === "canvas"
                    ? "bg-zinc-800 text-zinc-100"
                    : "bg-zinc-1000 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                }`}
              >
                <LayoutGrid className="size-3.5" />
              </button>
            )}
            {linkedLayers?.database && (
              <button
                type="button"
                title="Database layer"
                onClick={() => onLayerChange?.("database")}
                className={`flex size-6 items-center justify-center rounded transition-colors ${
                  activeLayer === "database"
                    ? "bg-zinc-800 text-zinc-100"
                    : "bg-zinc-1000 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                }`}
              >
                <Database className="size-3.5" />
              </button>
            )}
            {linkedLayers?.sketch && (
              <button
                type="button"
                title="Excalidraw layer"
                onClick={() => onLayerChange?.("sketch")}
                className={`flex size-6 items-center justify-center rounded transition-colors ${
                  activeLayer === "sketch"
                    ? "bg-zinc-800 text-zinc-100"
                    : "bg-zinc-1000 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                }`}
              >
                <PenLine className="size-3.5" />
              </button>
            )}
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          className={`size-7 hover:bg-zinc-800 ${isFocusMode ? "text-zinc-200" : "text-zinc-500 hover:text-white"}`}
          onClick={onToggleFocusMode}
          title={isFocusMode ? "Выйти из фокуса" : "Режим фокуса"}
        >
          {isFocusMode ? (
            <Minimize2 className="size-4" />
          ) : (
            <Maximize2 className="size-4" />
          )}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-zinc-500 hover:bg-zinc-800 hover:text-white"
            >
              <MoreVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-52 border-zinc-800 bg-black text-zinc-300"
          >
            <DropdownMenuCheckboxItem
              checked={viewMode === "source"}
              disabled={!document || activeLayer !== "editor" || isLocked}
              onCheckedChange={() =>
                onViewModeChange?.(viewMode === "source" ? "live" : "source")
              }
              className="text-[13px] focus:bg-zinc-800 focus:text-white"
            >
              <Code2 className="size-3.5" />
              Source Markdown
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={isLocked}
              disabled={!document}
              onCheckedChange={() => onToggleLock?.()}
              className="text-[13px] focus:bg-zinc-800 focus:text-white"
            >
              <Lock className="size-3.5" />
              Заблокировать
            </DropdownMenuCheckboxItem>
            {/* Attach layer options — only shown for layers not yet linked */}
            {document && (!linkedLayers?.canvas || !linkedLayers?.database || !linkedLayers?.sketch) && (
              <>
                <DropdownMenuSeparator className="bg-zinc-800" />
                {!linkedLayers?.canvas && (
                  <DropdownMenuItem
                    className="flex items-center gap-2 text-[13px] focus:bg-zinc-800 focus:text-white"
                    onSelect={() => setLayerConfirm("canvas")}
                  >
                    <LayoutGrid className="size-3.5 text-zinc-500" />
                    Прикрепить Canvas
                  </DropdownMenuItem>
                )}
                {!linkedLayers?.database && (
                  <DropdownMenuItem
                    className="flex items-center gap-2 text-[13px] focus:bg-zinc-800 focus:text-white"
                    onSelect={() => setLayerConfirm("database")}
                  >
                    <Database className="size-3.5 text-zinc-500" />
                    Прикрепить базу данных
                  </DropdownMenuItem>
                )}
                {!linkedLayers?.sketch && (
                  <DropdownMenuItem
                    className="flex items-center gap-2 text-[13px] focus:bg-zinc-800 focus:text-white"
                    onSelect={() => setLayerConfirm("sketch")}
                  >
                    <PenLine className="size-3.5 text-zinc-500" />
                    Прикрепить Excalidraw
                  </DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
    {/* Layer attachment confirmation dialog */}
    <Dialog
      open={layerConfirm !== null}
      onOpenChange={(open) => { if (!open) setLayerConfirm(null) }}
    >
      <DialogContent
        showCloseButton={false}
        className="w-72 border-zinc-800 bg-black p-4 text-zinc-200 sm:max-w-xs"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            if (layerConfirm) { onLayerChange?.(layerConfirm); setLayerConfirm(null) }
          }
        }}
      >
        <p className="text-[13px] leading-snug">
          Создать привязанный{" "}
          {layerConfirm ? layerLabelRu[layerConfirm] ?? layerConfirm : ""} к заметке?
        </p>
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-900"
            onClick={() => setLayerConfirm(null)}
          >
            Отмена
          </button>
          <button
            type="button"
            autoFocus
            className="rounded bg-zinc-100 px-2.5 py-1 text-xs font-medium text-black hover:bg-white"
            onClick={() => {
              if (layerConfirm) { onLayerChange?.(layerConfirm); setLayerConfirm(null) }
            }}
          >
            Создать
          </button>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );

  if (!document) {
    return (
      <div className="flex h-full flex-1 flex-col bg-background">
        {navBar}
        <div className="flex flex-1 flex-col items-center justify-center gap-6">
          <div className="text-center">
            <p className="text-lg font-medium text-zinc-300">
              Нет открытых заметок
            </p>
            <p className="mt-1 text-sm text-zinc-600">
              Создай новую или открой существующую
            </p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={onNewFile}
              className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-200 transition-colors hover:bg-zinc-800 hover:border-zinc-500"
            >
              <FilePlus className="size-4 text-zinc-400" />
              Создать заметку
            </button>
            <button
              onClick={onOpenVault}
              className="flex items-center gap-2 rounded-lg border border-zinc-800 px-4 py-2.5 text-sm text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-300"
            >
              <FolderOpen className="size-4" />
              Открыть хранилище
            </button>
          </div>
        </div>
      </div>
    );
  }

  const liveWordCount = content.split(/\s+/).filter(Boolean).length;
  const activeLayerMeta =
    LAYER_OPTIONS.find((option) => option.id === activeLayer) ??
    LAYER_OPTIONS[0];
  const ActiveLayerIcon = activeLayerMeta.icon;

  return (
    <div className="relative flex h-full flex-1 flex-col bg-background">
      {navBar}

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-10 py-8">
          {/* Title */}
          <div className="mb-4 flex items-center gap-3">
            {fileIcon &&
              !/^(folder|file|workspace|canvas|draft|brain)$/.test(
                fileIcon,
              ) && (
                <div className="relative shrink-0">
                  <button
                    type="button"
                    className="text-3xl leading-none transition-transform hover:scale-110 focus:outline-none"
                    title="Change icon"
                    onClick={() => setEmojiPickerOpen((v) => !v)}
                  >
                    {fileIcon}
                  </button>
                  {emojiPickerOpen && (
                    <div className="absolute left-0 top-full z-50 mt-1">
                      <EmojiPickerPanel
                        onSelect={(emojiData) => {
                          onFileIconChange?.(emojiData.native);
                          setEmojiPickerOpen(false);
                        }}
                        onClose={() => setEmojiPickerOpen(false)}
                      />
                    </div>
                  )}
                </div>
              )}
            {editingTitle ? (
              <input
                ref={titleInputRef}
                value={titleValue}
                onChange={(e) => setTitleValue(e.target.value)}
                onBlur={commitTitleRename}
                onKeyDown={handleTitleKeyDown}
                className="flex-1 bg-transparent text-3xl font-semibold tracking-tight text-zinc-100 outline-none border-b border-zinc-600 focus:border-zinc-400"
              />
            ) : (
              <h1
                className="text-3xl font-semibold tracking-tight text-zinc-100 cursor-text hover:text-white"
                onClick={() => {
                  setTitleValue(document.title);
                  setEditingTitle(true);
                }}
                title="Нажми чтобы переименовать"
              >
                {document.title}
              </h1>
            )}
          </div>

          <div className="mb-6 h-px bg-zinc-800" />

          {activeLayer !== "editor" ? (
            <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 rounded border border-dashed border-zinc-800 bg-zinc-950/40 text-center">
              <div className="flex size-12 items-center justify-center rounded border border-zinc-800 bg-zinc-900 text-zinc-300">
                <ActiveLayerIcon className="size-5" />
              </div>
              <div>
                <p className="text-sm font-medium text-zinc-300">
                  {activeLayerMeta.label}
                </p>
                <p className="mt-1 max-w-sm text-xs text-zinc-600">
                  Слой создан рядом с заметкой. Полноценный редактор появится в
                  следующем инкременте.
                </p>
              </div>
            </div>
          ) : viewMode === "source" ? (
            <SourceEditor
              key={document.id}
              value={content}
              onChange={handleContentChange}
              onTagClick={onTagClick}
              onWikiLinkClick={onWikiLinkClick}
              editorRef={editorRef}
              placeholder="Начни писать..."
            />
          ) : (
            <TiptapEditor
              key={document.id}
              value={content}
              onChange={handleContentChange}
              editorRef={editorRef}
              editable={viewMode === "live" && !isLocked}
              onTagClick={onTagClick}
              onWikiLinkClick={onWikiLinkClick}
              placeholder="Начни писать..."
              vaultPath={vault}
              notePath={document.path}
            />
          )}
        </div>
      </div>

      {/* Floating stats widget */}
      <div className="pointer-events-none absolute bottom-4 right-4 z-10">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/90 px-3 py-1.5 shadow-lg backdrop-blur-sm">
          <span className="text-[11px] text-zinc-500">{document.modified}</span>
          <span className="text-zinc-800">·</span>
          <span className="text-[11px] text-zinc-500">{liveWordCount} сл.</span>
          <div className="mx-1 h-3 w-px bg-zinc-800" />
          <button
            type="button"
            title={
              viewMode === "read" ? "Переключить в Live" : "Переключить в Read"
            }
            disabled={
              activeLayer !== "editor" || viewMode === "source" || isLocked
            }
            className="flex size-5 items-center justify-center rounded border border-zinc-800 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() =>
              onViewModeChange?.(viewMode === "read" ? "live" : "read")
            }
          >
            {viewMode === "read" ? (
              <Eye className="size-3" />
            ) : (
              <PenLine className="size-3" />
            )}
          </button>
          <div className="mx-1 h-3 w-px bg-zinc-800" />
          <button
            title="Отменить (Ctrl+Z)"
            className="flex size-5 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
            onMouseDown={(e) => {
              e.preventDefault();
              editorRef.current?.undo();
            }}
          >
            <Undo2 className="size-3" />
          </button>
          <button
            title="Повторить (Ctrl+Y)"
            className="flex size-5 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
            onMouseDown={(e) => {
              e.preventDefault();
              editorRef.current?.redo();
            }}
          >
            <Redo2 className="size-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
