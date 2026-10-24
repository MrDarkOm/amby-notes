import { TAGS_MODULE_DEFINITION } from "@/components/workspace/tags/tags-module"
import { HISTORY_MODULE_DEFINITION } from "@/components/workspace/history/history-module"
import { DATABASES_MODULE_DEFINITION } from "@/components/workspace/database/database-module"
import { FAVORITES_MODULE_DEFINITION } from "@/components/workspace/favorites/favorites-module"
import { LINKS_MODULE_DEFINITION } from "@/components/workspace/links/links-module"
import { GRAPH_MODULE_DEFINITION } from "@/components/workspace/graph/graph-module"
import { AI_MODULE_DEFINITION } from "@/components/workspace/ai/ai-module"
import { CANVAS_MODULE_DEFINITION } from "@/components/workspace/canvas/canvas-module"
import { SKETCH_MODULE_DEFINITION } from "@/components/workspace/sketch/sketch-module"
import { CREATIVE_MODULE_DEFINITION } from "@/components/workspace/creative/creative-module"
import { moduleHost } from "./module-host"

export function registerBuiltinModules(): void {
  moduleHost.registerModule(TAGS_MODULE_DEFINITION)
  moduleHost.registerModule(HISTORY_MODULE_DEFINITION)
  moduleHost.registerModule(DATABASES_MODULE_DEFINITION)
  moduleHost.registerModule(FAVORITES_MODULE_DEFINITION)
  moduleHost.registerModule(LINKS_MODULE_DEFINITION)
  moduleHost.registerModule(GRAPH_MODULE_DEFINITION)
  moduleHost.registerModule(AI_MODULE_DEFINITION)
  moduleHost.registerModule(CANVAS_MODULE_DEFINITION)
  moduleHost.registerModule(SKETCH_MODULE_DEFINITION)
  moduleHost.registerModule(CREATIVE_MODULE_DEFINITION)
}

// Auto-register built-in module definitions
registerBuiltinModules()
