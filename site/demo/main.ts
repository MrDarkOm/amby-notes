// A separate website entry. The desktop entry and storage adapter are unchanged.
// All browser-adapter writes stay in this frame's memory, including preferences.
const values = new Map<string, string>()
const memory: Storage = {
  get length() {
    return values.size
  },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => {
    values.delete(key)
  },
  setItem: (key, value) => {
    values.set(String(key), String(value))
  },
}
Object.defineProperty(window, "localStorage", { value: memory })
Object.defineProperty(window, "sessionStorage", { value: memory })

async function startDemo() {
  const params = new URLSearchParams(location.search)
  const lang = params.get("lang") === "en" ? "en" : "ru"
  const theme = params.get("theme") === "light" ? "light" : "dark"
  const en = lang === "en"
  const { FILE_PREFIX, TREE_KEY } = await import("../../src/lib/storage/web-tree")
  const { saveGlobalJSON } = await import("../../src/lib/storage")
  const { DEFAULT_PREFS } = await import("../../src/components/workspace/app-config")
  const notes = [
    {
      slug: "Start",
      title: en ? "A place for ideas" : "Место для идей",
      text: en
        ? "A notebook, a project, a story. In Amby, they can live side by side.\n\n> This is the real Amby editor running in your browser. Try changing this text.\n\n## Follow a thought\n\nA small idea can turn into [[Garden]] or [[Story]]. Open a note in the sidebar or follow a link.\n\n## Make it yours\n\n- [x] Find a place for your thoughts\n- [ ] Write the first sentence\n- [ ] Connect two ideas\n"
        : "Блокнот, проект, история. В Amby они могут жить рядом.\n\n> Это настоящий редактор Amby в браузере. Попробуйте изменить этот текст.\n\n## Продолжите мысль\n\nНебольшая идея может превратиться в [[Сад]] или [[История]]. Откройте заметку слева или перейдите по ссылке.\n\n## Начните с себя\n\n- [x] Найти место для мыслей\n- [ ] Написать первое предложение\n- [ ] Связать две идеи\n",
    },
    {
      slug: en ? "Garden" : "Сад",
      title: en ? "Garden" : "Сад",
      text: en
        ? "# A garden on the balcony\n\n#project #home\n\nA quiet corner with herbs, books and morning coffee.\n\n## First steps\n\n- [x] Measure the balcony\n- [ ] Choose basil and mint\n- [ ] Find pots\n\n## Notes\n\nKeep a little space for experiments. Like in [[Start]].\n"
        : "# Сад на балконе\n\n#проект #дом\n\nТихий уголок с травами, книгами и утренним кофе.\n\n## Первые шаги\n\n- [x] Измерить балкон\n- [ ] Выбрать базилик и мяту\n- [ ] Найти горшки\n\n## На заметку\n\nОставить немного места для экспериментов. Как в [[Start]].\n",
    },
    {
      slug: en ? "Story" : "История",
      title: en ? "Story" : "История",
      text: en
        ? "# The city that remembered\n\n#story\n\nEvery evening, the windows of the old house lit up in a different order. Mira was the first to notice they were spelling words.\n\n## Questions for the next chapter\n\n- Who built the house?\n- What does the city want to say?\n- Why has nobody noticed before?\n\nAn image for the opening scene: [[Garden]].\n"
        : "# Город, который помнил\n\n#история\n\nКаждый вечер окна старого дома загорались в новом порядке. Мира первой заметила, что они складываются в слова.\n\n## Вопросы к следующей главе\n\n- Кто построил этот дом?\n- Что город хочет сказать?\n- Почему раньше никто не замечал?\n\nОбраз для первой сцены: [[Сад]].\n",
    },
  ]
  const tree = notes.map((note) => ({
    id: `web-vault/${note.slug}.md`,
    path: `web-vault/${note.slug}.md`,
    name: note.title,
    type: "file",
    icon: "file",
  }))
  memory.setItem(TREE_KEY, JSON.stringify(tree))
  notes.forEach((note, index) => memory.setItem(FILE_PREFIX + tree[index].id, note.text))
  memory.setItem(
    "amby:tabs:web-vault",
    JSON.stringify({
      entries: [{ fileId: tree[0].id, title: notes[0].title }],
      activeFileId: tree[0].id,
    }),
  )
  await saveGlobalJSON("settings.json", {
    schemaVersion: 1,
    prefs: { ...DEFAULT_PREFS, language: lang, theme, accent: "rose" },
  })
  // The original application mounts its own stores, panels, editor and theme.
  await import("../../src/main")
  const { useSettingsStore } = await import("../../src/components/workspace/use-settings-store")
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== location.origin) return
    if (event.data?.type !== "amby-demo-theme") return
    const next = event.data.theme
    if (next !== "light" && next !== "dark") return
    void useSettingsStore.getState().setPrefs({ theme: next })
  })
  window.parent.postMessage({ type: "amby-demo-ready" }, location.origin)
}
void startDemo()
