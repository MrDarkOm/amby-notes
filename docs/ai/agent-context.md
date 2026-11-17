# Project context for AI agents

## How reading works

The shared entry point is [AGENTS.md](../../AGENTS.md): a short product description, mandatory
boundaries and the working order. The [root map](MAP.md) routes to the right subsystem. Local
`MAP.md` files next to the code show behavior owners, neighboring boundaries, contracts and the
matching tests. The full former rules live in [agent-guidelines.md](agent-guidelines.md), with
current paths and checks; read only the applicable sections.

The usual route: entry point → a row in the root map → one local map → the code and tests needed.
For example, an autosave bug leads to the [save map](../../src/components/workspace/autosave/MAP.md),
and a styling change to the [themes map](../../src/themes/MAP.md). A cross-layer task needs several
maps; do not artificially limit reading to one.

Maps are ordinary Markdown files. They are deliberately not named `AGENTS.md`, `CLAUDE.md` or
`GEMINI.md`: details open per task instead of all loading at once as instructions. The root files do
not import maps or the full rules.

All docs, maps, plans and instructions are written in English (owner's decision, 2026-11-17); Russian
is only an app interface language. Older Russian documents are translated over time.

## Entry points of different tools

| Tool                           | Entry point in this repository                               |
| ------------------------------ | ------------------------------------------------------------ |
| Codex                          | Root `AGENTS.md`                                             |
| Claude Code                    | `CLAUDE.md` imports only `@./AGENTS.md`                      |
| Gemini CLI                     | `GEMINI.md` imports only `@./AGENTS.md`                      |
| Another agent that reads files | Tell it: "Start with AGENTS.md and pick the route in MAP.md" |

Claude Code has three project skills in `.claude/skills/`: `amby-ipc-change` (an IPC command or
type), `amby-ui-strings` (visible text) and `amby-release` (release, promote, tags). A skill is a
short order of steps and pitfalls linking to these rules, not a copy of them; when they disagree, the
rules win. The folder lives only on `dev`. Third-party skill sets are not added: they do not know the
project's boundaries and conflict with them.

Shared rules exist in one copy. Do not copy them per model and do not add imports of all documents to
the adapters. Run the tool from the repository root; after changing instructions, open a new session.
Personal global instructions and agent settings may also affect the context.

The mechanisms were checked against the official documentation on October 1, 2026:
[Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md),
[Claude Code memory/imports](https://code.claude.com/docs/en/memory),
[Gemini CLI context/imports](https://geminicli.com/docs/cli/gemini-md/).
Codex collects instructions along the project path; Claude Code and Gemini CLI support Markdown
imports with `@`. In Gemini the loaded context can be viewed with `/memory show`. Client settings and
versions may change how files are discovered.

This reduces the startup documentation, but it does not give "zero context" or perfect understanding
without reading code. Every file read takes context; the agent must check the current behavior.
Automatic loading was not verified by starting separate sessions of all three CLIs; the adapters use
the documented syntax.

## Keeping maps current

When a behavior owner moves or a subsystem is added, update the nearest `MAP.md` in the same change.
Add a new map to the root or parent map. Link to stable files and folders, not line numbers, lists of
every function, current test counts or temporary task status. Plans and archives must not stand in
for a description of the implemented code.

`npm run docs:check` checks that local links exist, that every map is reachable from the root map,
the size budget of entry points and maps, and the single import of the shared rules in the adapters.
The check is part of the full gate and frontend CI. It does not check the meaning of descriptions,
Markdown anchors or external sites; whether file ownership is current remains part of review. The full
rules have no small size limit, since they are not loaded through an import.

For a manual check of a new session, give a safe task: "Find the owner of note saving and the related
tests; change nothing." The right route leads from the root map to autosave, storage and the Rust
commands without first reading all plans, fixtures and generated files.
