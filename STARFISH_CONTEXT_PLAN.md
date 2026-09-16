# NRGBot — Starfish Solution Awareness (Implementation Plan)

Give NRGBot persistent, automatic knowledge of the open **Starfish** solution (mixed
C#/C++ `.sln`) via two injected context sources: a **hand-authored knowledge doc** the
user maintains, and an **auto-generated project map** parsed from the `.sln` +
`.csproj`/`.vcxproj` projects. Both are composed into the system prompt, budget-capped
for the local model's context window, cached, and auto-refreshed on file changes (plus a
manual refresh command).

## Decisions (from requirements)

- **Starfish location:** the currently open VS Code workspace folder.
- **Approach:** hand-authored knowledge doc **and** auto-generated project map. (RAG /
  embeddings and new exploration tools are **out of scope** for now.)
- **Stack:** mixed C#/C++ (`.sln` with `.csproj` and `.vcxproj`).
- **Freshness:** auto-refresh matters — regenerate on demand and on file change.
- Context is **budget-capped** because `qwen2.5-coder:7b` has a limited window; the map
  is a compact summary, not a full file tree (the existing `list_directory` /
  `search_text` tools handle deep drilling on demand).

---

## Phase 1 — Project-context module (`src/projectContext.ts`, new)

1. `readKnowledgeDoc()` — read the configured knowledge file (default
   `.nrgbot/knowledge.md`) from the workspace root; return `''` if absent; truncate to
   budget.
2. `generateProjectMap()` — find `**/*.sln`, parse
   `Project(...) = "Name", "rel\path.csproj", "{GUID}"` entries; for each referenced
   project read minimal facts:
   - `.csproj`: `<TargetFramework(s)>` / legacy `<TargetFrameworkVersion>`,
     `<OutputType>` → language "C#".
   - `.vcxproj`: `<ConfigurationType>` (Application/DynamicLibrary/StaticLibrary),
     `<PlatformToolset>` → language "C++".
   - Emit one compact line per project:
     `- Name (C#, net8.0, Exe) — relative/folder`.
   - Prepend solution name, project count, and a shallow (depth-1) top-level folder
     listing for orientation.
3. If no `.sln` is found, fall back to a lightweight top-level scan so the map is still
   useful.
4. Enforce a total character budget (`nrgbot.projectContextMaxChars`) so it never blows
   the context window; note truncation in the text.

## Phase 2 — Caching & freshness

5. Cache the generated map + knowledge text in the provider. On first use, generate
   lazily (await).
6. Add `vscode.workspace.createFileSystemWatcher('**/*.{sln,csproj,vcxproj}')` and a
   watcher on the knowledge file; invalidate cache on create/change/delete so the next
   request regenerates.
7. Add command `nrgbot.refreshProjectContext` ("NRGBot: Refresh Project Context") to
   force-regenerate on demand.

## Phase 3 — System-prompt assembly

8. Refactor the inline `systemMessage` in `_postChatCompletion`
   (`src/extension.ts`, ~L497) into a `buildSystemPrompt(cachedContext)` that
   concatenates: existing base instructions + a `## Project knowledge (Starfish)`
   section + a `## Solution map` section, each clearly labeled and included only when
   non-empty.
9. Wire the cached context through `_streamFromOllama` → `_postChatCompletion` so every
   turn (including tool round-trips) carries it cheaply.

## Phase 4 — Settings & bootstrap

10. Add to `contributes.configuration` in `package.json`:
    - `nrgbot.knowledgeFile` (string, default `.nrgbot/knowledge.md`)
    - `nrgbot.includeProjectMap` (boolean, default `true`)
    - `nrgbot.projectContextMaxChars` (number, default `6000`)
11. Register the `refreshProjectContext` command in `contributes.commands` and in
    `activate()` (`src/extension.ts`, ~L7).
12. Optional bootstrap command `nrgbot.generateKnowledgeDoc` that scaffolds a starter
    `.nrgbot/knowledge.md` template (purpose, architecture, key files/entry points,
    conventions) so there is a structure to fill in.

---

## Relevant files

- `src/projectContext.ts` *(new)* — `.sln`/`.csproj`/`.vcxproj` parsing, knowledge-doc
  reading, budgeting. Reuse the workspace-scoping pattern from `resolveWorkspacePath` in
  `src/tools.ts`.
- `src/extension.ts` (~L497) — refactor `systemMessage` into `buildSystemPrompt`; add
  cache fields, watcher, and command registration in `activate` (~L7).
- `package.json` (`contributes.configuration` / new `contributes.commands`) — new
  settings + command.
- `src/test/projectContext.test.ts` *(new)* — unit-test the `.sln`/project parser and
  budget truncation with fixtures.

## Verification

1. `npm run compile` clean; `npm test` green (existing 23 + new parser tests).
2. Open a Starfish-like fixture with a `.sln` + one `.csproj` + one `.vcxproj`; run
   "NRGBot: Refresh Project Context"; confirm the map lists both projects with
   language/framework.
3. Ask NRGBot "what is this solution and its main projects?" with tools off — it should
   answer from injected context without calling `read_file`.
4. Add a `.nrgbot/knowledge.md`, reload/edit it, confirm the watcher picks up changes on
   the next message.
5. Confirm the injected context respects `projectContextMaxChars` (set it low, verify the
   truncation note appears).

## Further considerations

1. **Knowledge-doc convention** — Option A: `.nrgbot/knowledge.md` (default,
   NRGBot-specific). Option B: also auto-detect a root `AGENTS.md` /
   `.github/copilot-instructions.md` if present. Recommend **A** now, B as an easy
   fallback add later.
2. **Bootstrap command** (step 12) — recommend **yes**; makes the hand-authored doc easy
   to start at low cost.
3. **Default `projectContextMaxChars`** — 6000 is conservative for a 7B model. Raise it
   if larger-context models are used regularly; keep 6000 as the tunable default.
