"use client"

import * as React from "react"
import { AppSidebar } from "./app-sidebar"
import { DocumentEditor } from "./document-editor"
import { PropertiesPanel } from "./properties-panel"
import { HeaderTabs } from "./header-tabs"

const documents = {
  "project-alpha": {
    id: "project-alpha",
    title: "Project Alpha",
    content: "",
    modified: "Just now",
    wordCount: 0,
  },
  "project-beta": {
    id: "project-beta",
    title: "Project Beta",
    content: "This is a sample project document.",
    modified: "2h ago",
    wordCount: 6,
  },
  "notes-1": {
    id: "notes-1",
    title: "Notes",
    content: "Quick notes for the day.",
    modified: "Yesterday",
    wordCount: 5,
  },
  "notes-2": {
    id: "notes-2",
    title: "Notes 2",
    content: "Second notes document.",
    modified: "Yesterday",
    wordCount: 3,
  },
  "draft-notes-1": {
    id: "draft-notes-1",
    title: "Draft Notes 1",
    content: "",
    modified: "3d ago",
    wordCount: 0,
  },
  "draft-notes-2": {
    id: "draft-notes-2",
    title: "Draft Notes 2",
    content: "",
    modified: "3d ago",
    wordCount: 0,
  },
}

const documentProperties = {
  "project-alpha": {
    type: "Markdown",
    status: "Draft",
    revisions: 14,
    backlinks: 3,
    created: "24 / 10 / 2023 23:39",
    modified: "2h ago",
    id: "1278-4124-4214-1241",
  },
  "project-beta": {
    type: "Markdown",
    status: "In Progress",
    revisions: 8,
    backlinks: 1,
    created: "20 / 10 / 2023 14:22",
    modified: "1d ago",
    id: "2341-5231-6342-7453",
  },
  "notes-1": {
    type: "Markdown",
    status: "Draft",
    revisions: 2,
    backlinks: 0,
    created: "25 / 10 / 2023 09:15",
    modified: "Yesterday",
    id: "8564-9675-0786-1897",
  },
  "notes-2": {
    type: "Markdown",
    status: "Draft",
    revisions: 1,
    backlinks: 0,
    created: "25 / 10 / 2023 10:00",
    modified: "Yesterday",
    id: "1212-3434-5656-7878",
  },
  "draft-notes-1": {
    type: "Markdown",
    status: "Draft",
    revisions: 0,
    backlinks: 0,
    created: "22 / 10 / 2023 17:20",
    modified: "3d ago",
    id: "9898-7676-5454-3232",
  },
  "draft-notes-2": {
    type: "Markdown",
    status: "Draft",
    revisions: 0,
    backlinks: 0,
    created: "22 / 10 / 2023 17:25",
    modified: "3d ago",
    id: "1111-2222-3333-4444",
  },
}

type DocumentId = keyof typeof documents

function isDocumentId(id: string): id is DocumentId {
  return id in documents
}

export function Workspace() {
  const [selectedId, setSelectedId] = React.useState<DocumentId>("project-alpha")
  const [tabs, setTabs] = React.useState([
    { id: "project-alpha", title: "Project Alpha" },
  ])
  const [activeTabId, setActiveTabId] = React.useState("project-alpha")
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = React.useState(true)
  const [isRightSidebarOpen, setIsRightSidebarOpen] = React.useState(true)

  const currentDocument = documents[selectedId]
  const currentProperties = documentProperties[selectedId]

  const handleSelect = (id: string) => {
    if (!isDocumentId(id)) return
    setSelectedId(id)
    
    // Add tab if not exists
    if (!tabs.find((tab) => tab.id === id)) {
      const doc = documents[id]
      setTabs([...tabs, { id, title: doc.title }])
    }
    setActiveTabId(id)
  }

  const handleTabChange = (tabId: string) => {
    if (!isDocumentId(tabId)) return
    setActiveTabId(tabId)
    setSelectedId(tabId)
  }

  const handleTabClose = (tabId: string) => {
    const newTabs = tabs.filter((tab) => tab.id !== tabId)
    setTabs(newTabs)
    
    if (activeTabId === tabId && newTabs.length > 0) {
      setActiveTabId(newTabs[0].id)
      if (isDocumentId(newTabs[0].id)) {
        setSelectedId(newTabs[0].id)
      }
    } else if (newTabs.length === 0) {
      setActiveTabId("")
      setSelectedId("project-alpha")
      setTabs([{ id: "project-alpha", title: "Project Alpha" }])
    }
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <HeaderTabs
        tabs={tabs}
        activeTabId={activeTabId}
        onTabChange={handleTabChange}
        onTabClose={handleTabClose}
        onToggleLeftSidebar={() => setIsLeftSidebarOpen(!isLeftSidebarOpen)}
        onToggleRightSidebar={() => setIsRightSidebarOpen(!isRightSidebarOpen)}
        isLeftSidebarOpen={isLeftSidebarOpen}
        isRightSidebarOpen={isRightSidebarOpen}
      />
      
      <div className="flex flex-1 overflow-hidden">
        {isLeftSidebarOpen && (
          <AppSidebar selectedId={selectedId} onSelect={handleSelect} />
        )}
        
        <main className="flex flex-1 overflow-hidden">
          <DocumentEditor document={currentDocument || null} />
        </main>
        
        {isRightSidebarOpen && (
          <PropertiesPanel properties={currentProperties || null} />
        )}
      </div>
    </div>
  )
}
