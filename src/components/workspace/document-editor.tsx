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
import { CanvasEditor } from "./canvas-editor";
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
import type { TreeItem } from "./sidebar-tree";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

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
  treeItems?: TreeItem[];
  onOpenItem?: (id: string) => void;
  onUnlinkLayer?: (layer: "canvas" | "database" | "sketch") => void;
  onDeleteLayer?: (layer: "canvas" | "database" | "sketch") => void;
  canvasValue?: string;
  onCanvasChange?: (json: string) => void;
  onOpenCanvasNote?: (file: string) => void;
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

interface BreadcrumbSegment {
  id: string;
  name: string;
  kind: "file" | "folder";
}

function stripMdExt(name: string): string {
  return name.replace(/\.md$/iu, "");
}

function findBreadcrumbTrail(
  items: TreeItem[],
  targetId: string,
): TreeItem[] | null {
  for (const item of items) {
    if (item.id === targetId) return [item];
    if (item.children) {
      const sub = findBreadcrumbTrail(item.children, targetId);
      if (sub) return [item, ...sub];
    }
  }
  return null;
}

function buildBreadcrumb(
  treeItems: TreeItem[] | undefined,
  docId: string | undefined,
): BreadcrumbSegment[] {
  if (!treeItems || !docId) return [];
  const trail = findBreadcrumbTrail(treeItems, docId);
  if (!trail) return [];
  const segments: BreadcrumbSegment[] = [];
  for (let i = 0; i < trail.length; i++) {
    const item = trail[i];
    const next = trail[i + 1];
    // Bundle collapse: folder whose name matches the next (file) child's name.
    // The sidebar effectively presents these as one entry.
    if (
      next &&
      item.type === "folder" &&
      next.type === "file" &&
      stripMdExt(item.name) === stripMdExt(next.name)
    ) {
      continue;
    }
    segments.push({
      id: item.id,
      name: stripMdExt(item.name),
      kind: item.type === "folder" ? "folder" : "file",
    });
  }
  return segments;
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
  treeItems,
  onOpenItem,
  onUnlinkLayer,
  onDeleteLayer,
  canvasValue,
  onCanvasChange,
  onOpenCanvasNote,
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

  const breadcrumb = React.useMemo(
    () => buildBreadcrumb(treeItems, document?.id),
    [treeItems, document?.id],
  );

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

      {/* Center: breadcrumb mirroring the tree */}
      <div className="flex min-w-0 flex-1 items-center justify-center gap-1 overflow-hidden px-2 text-xs">
        {breadcrumb.length > 0 ? (
          breadcrumb.map((seg, idx) => {
            const isLast = idx === breadcrumb.length - 1;
            const isClickable = !isLast && seg.kind === "file" && !!onOpenItem;
            return (
              <React.Fragment key={seg.id}>
                {isClickable ? (
                  <button
                    type="button"
                    className="max-w-[200px] truncate rounded px-1 py-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                    onClick={() => onOpenItem?.(seg.id)}
                    title={seg.name}
                  >
                    {seg.name}
                  </button>
                ) : (
                  <span
                    className={`max-w-[260px] truncate px-1 ${isLast ? "text-zinc-300" : "text-zinc-500"}`}
                    title={seg.name}
                  >
                    {seg.name}
                  </span>
                )}
                {!isLast && (
                  <span className="shrink-0 text-zinc-700">›</span>
                )}
              </React.Fragment>
            );
          })
        ) : document ? (
          <span className="truncate text-zinc-400">{document.title}</span>
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
            {/* Only show attached (linked) layers — right-click for unlink/delete */}
            {linkedLayers?.canvas && (
              <LayerButton
                layer="canvas"
                title="Canvas layer"
                icon={<LayoutGrid className="size-3.5" />}
                active={activeLayer === "canvas"}
                onActivate={() => onLayerChange?.("canvas")}
                onUnlink={onUnlinkLayer}
                onDelete={onDeleteLayer}
              />
            )}
            {linkedLayers?.database && (
              <LayerButton
                layer="database"
                title="Database layer"
                icon={<Database className="size-3.5" />}
                active={activeLayer === "database"}
                onActivate={() => onLayerChange?.("database")}
                onUnlink={onUnlinkLayer}
                onDelete={onDeleteLayer}
              />
            )}
            {linkedLayers?.sketch && (
              <LayerButton
                layer="sketch"
                title="Excalidraw layer"
                icon={<PenLine className="size-3.5" />}
                active={activeLayer === "sketch"}
                onActivate={() => onLayerChange?.("sketch")}
                onUnlink={onUnlinkLayer}
                onDelete={onDeleteLayer}
              />
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

  // Canvas layer: borderless, full-bleed infinite canvas (no title / scroll column).
  if (activeLayer === "canvas") {
    return (
      <div className="relative flex h-full flex-1 flex-col bg-background">
        {navBar}
        <div className="flex-1 overflow-hidden">
          <CanvasEditor
            key={`${document.id}:canvas`}
            value={canvasValue ?? "{}"}
            onChange={(json) => onCanvasChange?.(json)}
            vault={vault ?? null}
            notePath={document.path}
            onOpenNote={onOpenCanvasNote}
          />
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
        <div className="mx-auto px-10 py-8" style={{ maxWidth: "var(--content-max-width, 48rem)" }}>
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

type LayerKind = "canvas" | "database" | "sketch";

function LayerButton({
  layer,
  title,
  icon,
  active,
  onActivate,
  onUnlink,
  onDelete,
}: {
  layer: LayerKind;
  title: string;
  icon: React.ReactNode;
  active: boolean;
  onActivate: () => void;
  onUnlink?: (layer: LayerKind) => void;
  onDelete?: (layer: LayerKind) => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          title={title}
          onClick={onActivate}
          className={`flex size-6 items-center justify-center rounded transition-colors ${
            active
              ? "bg-zinc-800 text-zinc-100"
              : "bg-zinc-1000 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          }`}
        >
          {icon}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={() => onUnlink?.(layer)}>
          Отвязать
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => onDelete?.(layer)}
          className="text-red-400 focus:text-red-300"
        >
          Удалить
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
