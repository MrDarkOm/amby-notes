import type { ActionDef, PanelDef } from "@/components/workspace/panel-registry"
import type { BackgroundTaskHandle, FileHandlerDefinition } from "./sdk"

export class FileHandlerRegistry {
  private handlers = new Map<string, FileHandlerDefinition>()

  register(handler: FileHandlerDefinition): () => void {
    const ext = handler.extension.toLowerCase().replace(/^\./, "")
    this.handlers.set(ext, handler)
    return () => {
      if (this.handlers.get(ext) === handler) {
        this.handlers.delete(ext)
      }
    }
  }

  getHandler(extension: string): FileHandlerDefinition | undefined {
    const ext = extension.toLowerCase().replace(/^\./, "")
    return this.handlers.get(ext)
  }

  hasHandler(extension: string): boolean {
    const ext = extension.toLowerCase().replace(/^\./, "")
    return this.handlers.has(ext)
  }

  unregisterAllForModule(moduleId: string): void {
    for (const [ext, handler] of this.handlers.entries()) {
      if (handler.moduleId === moduleId) {
        this.handlers.delete(ext)
      }
    }
  }

  clear(): void {
    this.handlers.clear()
  }
}

export class PanelContributionRegistry {
  private panels = new Map<string, { panel: PanelDef; moduleId: string }>()

  register(panel: PanelDef, moduleId: string): () => void {
    this.panels.set(panel.id, { panel, moduleId })
    return () => {
      const existing = this.panels.get(panel.id)
      if (existing?.panel === panel) {
        this.panels.delete(panel.id)
      }
    }
  }

  getPanel(id: string): PanelDef | undefined {
    return this.panels.get(id)?.panel
  }

  getAllPanels(): PanelDef[] {
    return Array.from(this.panels.values()).map((p) => p.panel)
  }

  unregisterAllForModule(moduleId: string): void {
    for (const [id, entry] of this.panels.entries()) {
      if (entry.moduleId === moduleId) {
        this.panels.delete(id)
      }
    }
  }

  clear(): void {
    this.panels.clear()
  }
}

export class CommandContributionRegistry {
  private commands = new Map<string, { action: ActionDef; moduleId: string }>()

  register(action: ActionDef, moduleId: string): () => void {
    this.commands.set(action.id, { action, moduleId })
    return () => {
      const existing = this.commands.get(action.id)
      if (existing?.action === action) {
        this.commands.delete(action.id)
      }
    }
  }

  getCommand(id: string): ActionDef | undefined {
    return this.commands.get(id)?.action
  }

  getAllCommands(): ActionDef[] {
    return Array.from(this.commands.values()).map((c) => c.action)
  }

  unregisterAllForModule(moduleId: string): void {
    for (const [id, entry] of this.commands.entries()) {
      if (entry.moduleId === moduleId) {
        this.commands.delete(id)
      }
    }
  }

  clear(): void {
    this.commands.clear()
  }
}

export class TaskContributionRegistry {
  private tasks = new Map<string, BackgroundTaskHandle>()

  register(task: BackgroundTaskHandle): () => void {
    this.tasks.set(task.id, task)
    return () => {
      if (this.tasks.get(task.id) === task) {
        this.tasks.delete(task.id)
      }
    }
  }

  getActiveTasks(): BackgroundTaskHandle[] {
    return Array.from(this.tasks.values())
  }

  async stopAllForModule(moduleId: string): Promise<void> {
    const tasksToStop: BackgroundTaskHandle[] = []
    for (const [id, task] of this.tasks.entries()) {
      if (task.moduleId === moduleId) {
        tasksToStop.push(task)
        this.tasks.delete(id)
      }
    }
    await Promise.all(
      tasksToStop.map(async (task) => {
        try {
          await task.stop()
        } catch (error) {
          console.error(
            `Failed to stop background task "${task.id}" for module "${moduleId}":`,
            error,
          )
        }
      }),
    )
  }

  clear(): void {
    this.tasks.clear()
  }
}
