"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { ChevronRight, Plus, RotateCcw, Search, X } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import {
  GRAPH_RANGES,
  GROUP_COLORS,
  type GraphGroup,
  type GraphRangeKey,
  type GraphSettings,
} from "./graph-settings"

interface GraphSettingsPanelProps {
  settings: GraphSettings
  onChange: (patch: Partial<GraphSettings>) => void
  onReset: () => void
  onClose: () => void
  onAnimate: () => void
  /** A locked graph keeps its layout, so it cannot be replayed. */
  animateDisabled?: boolean
}

type SectionId = "filters" | "groups" | "display" | "forces"

export function GraphSettingsPanel({
  settings,
  onChange,
  onReset,
  onClose,
  onAnimate,
  animateDisabled = false,
}: GraphSettingsPanelProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState<Record<SectionId, boolean>>({
    filters: true,
    groups: true,
    display: true,
    forces: false,
  })
  const toggle = (id: SectionId) => setOpen((prev) => ({ ...prev, [id]: !prev[id] }))

  const updateGroup = (id: string, patch: Partial<GraphGroup>) =>
    onChange({ groups: settings.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) })

  const addGroup = () =>
    onChange({
      groups: [
        ...settings.groups,
        {
          id: `group-${Date.now().toString(36)}`,
          query: "",
          color: GROUP_COLORS[settings.groups.length % GROUP_COLORS.length],
        },
      ],
    })

  const slider = (key: GraphRangeKey, digits = 2) => (
    <GraphSlider
      label={t(`graph.settings.${key}`)}
      value={settings[key]}
      digits={digits}
      {...GRAPH_RANGES[key]}
      onChange={(value) => onChange({ [key]: value })}
    />
  )

  return (
    <div
      className="flex max-h-full w-64 flex-col overflow-hidden rounded-xl border border-border/80 bg-card/95 text-foreground shadow-lg backdrop-blur-md"
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="min-h-0 overflow-y-auto">
        <Section
          title={t("graph.settings.filters")}
          open={open.filters}
          onToggle={() => toggle("filters")}
          actions={
            <>
              <IconButton title={t("graph.settings.reset")} onClick={onReset}>
                <RotateCcw className="size-3.5" />
              </IconButton>
              <IconButton title={t("graph.settings.close")} onClick={onClose}>
                <X className="size-3.5" />
              </IconButton>
            </>
          }
        >
          <label className="flex h-8 items-center gap-2 rounded-lg border border-border/80 bg-background/60 px-2.5 focus-within:border-ring">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={settings.search}
              onChange={(e) => onChange({ search: e.target.value })}
              placeholder={t("graph.settings.searchPlaceholder")}
              title={t("graph.settings.queryHint")}
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
            />
          </label>
          <Toggle
            label={t("graph.settings.tags")}
            checked={settings.showTags}
            onChange={(showTags) => onChange({ showTags })}
          />
          <Toggle
            label={t("graph.settings.attachments")}
            checked={settings.showAttachments}
            onChange={(showAttachments) => onChange({ showAttachments })}
          />
          <Toggle
            label={t("graph.settings.existingOnly")}
            checked={settings.existingOnly}
            onChange={(existingOnly) => onChange({ existingOnly })}
          />
          <Toggle
            label={t("graph.settings.orphans")}
            checked={settings.showOrphans}
            onChange={(showOrphans) => onChange({ showOrphans })}
          />
        </Section>

        <Section
          title={t("graph.settings.groups")}
          open={open.groups}
          onToggle={() => toggle("groups")}
        >
          {settings.groups.map((group) => (
            <div key={group.id} className="flex items-center gap-1.5">
              <input
                value={group.query}
                onChange={(e) => updateGroup(group.id, { query: e.target.value })}
                placeholder={t("graph.settings.groupPlaceholder")}
                title={t("graph.settings.queryHint")}
                className="h-8 min-w-0 flex-1 rounded-lg border border-border/80 bg-background/60 px-2.5 text-[12px] outline-none placeholder:text-muted-foreground focus:border-ring"
              />
              <label
                title={t("graph.settings.groupColor")}
                className="relative size-5 shrink-0 cursor-pointer rounded-full border border-border/60"
                style={{ backgroundColor: group.color }}
              >
                <input
                  type="color"
                  value={group.color}
                  onChange={(e) => updateGroup(group.id, { color: e.target.value })}
                  className="absolute inset-0 size-full cursor-pointer opacity-0"
                />
              </label>
              <IconButton
                title={t("graph.settings.removeGroup")}
                onClick={() =>
                  onChange({ groups: settings.groups.filter((g) => g.id !== group.id) })
                }
              >
                <X className="size-3.5" />
              </IconButton>
            </div>
          ))}
          <button
            type="button"
            onClick={addGroup}
            className="flex h-8 items-center justify-center gap-1.5 rounded-lg bg-muted/70 text-[12px] font-medium text-foreground hover:bg-accent"
          >
            <Plus className="size-3.5" />
            {t("graph.settings.newGroup")}
          </button>
        </Section>

        <Section
          title={t("graph.settings.display")}
          open={open.display}
          onToggle={() => toggle("display")}
        >
          <Toggle
            label={t("graph.settings.arrows")}
            checked={settings.showArrows}
            onChange={(showArrows) => onChange({ showArrows })}
          />
          {slider("textFadeThreshold")}
          {slider("nodeSize")}
          {slider("linkThickness")}
          <button
            type="button"
            onClick={onAnimate}
            disabled={animateDisabled}
            className="ml-auto flex h-8 items-center rounded-lg bg-muted/70 px-3 text-[12px] font-medium text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
          >
            {t("graph.settings.animate")}
          </button>
        </Section>

        <Section
          title={t("graph.settings.forces")}
          open={open.forces}
          onToggle={() => toggle("forces")}
        >
          {slider("centerForce")}
          {slider("repelForce")}
          {slider("linkForce")}
          {slider("linkDistance", 0)}
        </Section>
      </div>
    </div>
  )
}

function Section({
  title,
  open,
  onToggle,
  actions,
  children,
}: {
  title: string
  open: boolean
  onToggle: () => void
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="border-b border-border/70 last:border-b-0">
      <div className="flex items-center gap-1 px-2 pt-2 pb-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left text-[12px] font-semibold text-foreground hover:bg-accent/50"
        >
          <ChevronRight
            className={cn("size-3.5 shrink-0 text-muted-foreground", open && "rotate-90")}
          />
          <span className="truncate">{title}</span>
        </button>
        {actions}
      </div>
      {open ? <div className="flex flex-col gap-2.5 px-3 pt-1 pb-3">{children}</div> : null}
    </section>
  )
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-[12px] text-foreground">
      <span className="min-w-0">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}

function GraphSlider({
  label,
  value,
  min,
  max,
  step,
  digits,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  digits: number
  onChange: (value: number) => void
}) {
  const percent = ((value - min) / (max - min)) * 100
  return (
    <label className="flex flex-col gap-1 text-[12px] text-foreground">
      <span>{label}</span>
      <span className="flex items-center gap-2">
        <span className="w-9 shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {value.toFixed(digits)}
        </span>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="amby-graph-slider h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full"
          style={{
            background: `linear-gradient(to right, hsl(var(--primary)) ${percent}%, hsl(var(--muted)) ${percent}%)`,
          }}
        />
      </span>
    </label>
  )
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  )
}
