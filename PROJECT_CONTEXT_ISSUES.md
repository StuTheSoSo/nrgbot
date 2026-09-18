# NRGBot Project Context Issues and Implementation Prompts

Prioritized backlog for making NRGBot understand the open solution, use the curated
knowledge document consistently, inspect source when needed, and produce grounded,
intelligent responses.

The prompts below are intended to be handled in order. Each prompt is self-contained
enough to use as a coding-agent task, but later prompts may build on earlier changes.

---

## Priority 1 - Correct Context Routing

### 1. Allow source exploration when baseline context is incomplete

**Issue**

`src/extension.ts` disables workspace tools for ordinary questions whenever either the
knowledge document or generated project map is non-empty. A shallow map can therefore
prevent the model from gathering the evidence needed to answer a detailed question.

**Desired behavior**

- Always provide the curated knowledge and generated solution map as baseline context.
- Keep read-only workspace tools available when tools are enabled.
- Tell the model to answer directly when the baseline fully answers the question.
- Tell it to inspect the smallest relevant set of files when the baseline is
  insufficient.
- Never guess project-specific facts that can be verified with a tool.

**Implementation prompt**

```text
Improve NRGBot's tool-routing logic so the existence of project knowledge does not
prevent source exploration.

Start in src/extension.ts at _postChatCompletion, buildSystemPrompt, and the logic that
computes offerTools, fileAction, and injectKnowledge. Preserve the special attached-file
behavior and the post-tool loop protections.

Requirements:
1. When nrgbot.enableTools is true, ordinary project questions may use the read-only
   workspace tools even when project knowledge or a solution map exists.
2. Baseline knowledge must still be sent on those requests.
3. Update the system instructions to distinguish two cases: answer from baseline
   context when sufficient; otherwise inspect relevant workspace files before making a
   project-specific claim.
4. Preserve the lean prompt for explicit file-action requests if it remains necessary
   for reliable tool calling.
5. Never encourage broad, unnecessary repository scans.
6. Extract pure routing decisions into exported/testable functions if needed rather
   than testing private methods indirectly.
7. Add focused tests covering ordinary questions with knowledge, ordinary questions
   without knowledge, explicit file actions, attachments, cross-file attachment
   questions, and post-tool requests.

Run npm run compile, the focused tests, and npm run lint. Keep the change narrowly
scoped and report any behavior tradeoffs.
```

**Acceptance criteria**

- [x] A detailed project question can trigger tools even when knowledge is present.
- [x] Knowledge remains in the request while tools are offered.
- [x] Attached-file and post-tool behavior does not regress.
- [x] Routing cases have automated tests.

### 2. Place baseline context near the current question

**Issue**

Knowledge turns are currently inserted before the complete conversation history. As a
conversation grows, the supposedly recent reference becomes remote from the current
question and receives less model attention.

**Desired behavior**

Place the reference immediately before the latest user turn while preserving valid
message ordering for assistant/tool-call exchanges.

**Implementation prompt**

```text
Change NRGBot's message composition so project knowledge and the solution map are close
to the current user question instead of preceding the entire conversation.

Start in src/extension.ts at _buildKnowledgeTurns and _postChatCompletion.

Requirements:
1. Compose messages as: system prompt, prior conversation, injected project-context
   reference, latest user message.
2. Do not split an assistant tool-call message from its corresponding tool results.
3. Do not duplicate context during recursive tool-call iterations.
4. Keep context present when a request needs both grounding and tools.
5. Use neutral provenance-aware wording rather than an artificial assistant
   acknowledgement that claims understanding before the model processes the question.
6. Extract message composition into a pure function and test empty history, multi-turn
   history, attachments, and tool-call history.

Run npm run compile, the focused tests, and npm run lint.
```

**Acceptance criteria**

- [x] The latest user question follows the injected context directly.
- [x] Context appears exactly once per API request.
- [x] OpenAI-compatible tool message ordering remains valid.
- [x] Message ordering has automated tests.

---

## Priority 2 - Richer Solution Understanding

### 3. Generate a semantic project and dependency map

**Issue**

`src/projectContext.ts` currently emits project names, languages, folders, and a few XML
properties. It does not capture dependencies, project roles, entry points, package
usage, or other facts needed for architectural reasoning.

**Desired output**

```text
Solution: Starfish.sln
Project: Gateway.Service
Path: src/Gateway.Service/Gateway.Service.csproj
Kind: executable/service
Targets: net8.0
References: Gateway.Core, Radio.Native
Packages: Microsoft.Extensions.Hosting, Serilog
Entry points: Program.cs

Dependency edges:
Gateway.Service -> Gateway.Core
Gateway.Service -> Radio.Native
Gateway.Tests -> Gateway.Core
```

**Implementation prompt**

```text
Expand src/projectContext.ts from a project inventory into a compact semantic solution
map for mixed .NET and C++ solutions.

Requirements:
1. Replace loose string facts with typed project metadata while preserving a compact
   rendered map.
2. Parse .NET TargetFramework/TargetFrameworks, OutputType, AssemblyName,
   RootNamespace, IsTestProject, ProjectReference, and PackageReference.
3. Parse C++ ConfigurationType, PlatformToolset, RootNamespace, ProjectReference, and
   AdditionalDependencies where practical.
4. Resolve project references to solution project names when possible and retain a
   normalized relative path when not possible.
5. Classify projects conservatively as executable, library, test, shared, or unknown.
   Do not infer domain responsibilities from names alone.
6. Find probable entry-point files using small bounded searches appropriate to the
   project type, such as Program.cs, App.xaml, main.cpp, or WinMain sources. Label them
   as probable rather than authoritative when inferred.
7. Emit deterministic project records and a dependency-edge section. Sort solutions,
   projects, references, packages, and entry points for stable output.
8. Handle conditioned property groups and repeated values without emitting duplicates.
9. Do not add an XML dependency unless the existing toolchain truly needs one; if regex
   parsing becomes fragile, prefer a small established XML parser and explain why.
10. Add fixture-based tests for SDK-style C#, legacy C#, C++, test projects,
    multi-targeting, project references, packages, missing referenced projects, and
    conditioned duplicate properties.

Keep output compact enough for a local model. Run npm run compile, focused tests, and
npm run lint.
```

**Acceptance criteria**

- [x] The map describes project relationships, not only project labels.
- [x] Facts retain source paths and clear provenance.
- [x] Rendering is deterministic and deduplicated.
- [x] Mixed C# and C++ fixtures are covered.

### 4. Improve fallback discovery when no solution exists

**Issue**

The no-solution fallback only lists top-level files and folders. It does not identify
common manifests, entry points, languages, tests, documentation, or build commands.

**Implementation prompt**

```text
Make generateProjectMap useful for workspaces that do not contain a .sln file.

Start in src/projectContext.ts at overviewWithoutSolution.

Requirements:
1. Detect common root manifests and build files, including package.json, *.code-workspace,
   CMakeLists.txt, Directory.Build.props, global.json, pyproject.toml, Cargo.toml, and
   README files.
2. Identify likely source and test roots using a bounded depth and bounded result count.
3. Summarize detected languages from file extensions without scanning generated or
   dependency directories.
4. Extract only safe, high-value structured facts, such as package.json scripts, using
   proper parsers rather than regular expressions.
5. Keep paths workspace-relative, output deterministic, and all searches budgeted.
6. Add tests for a TypeScript workspace, a CMake workspace, an empty workspace, and
   excluded dependency/build directories.

Run npm run compile, focused tests, and npm run lint.
```

**Acceptance criteria**

- [x] Common manifests, build files, and package scripts are identified.
- [x] Source roots, test roots, languages, and probable entry points are summarized.
- [x] Discovery is deterministic and bounded by depth and entry count.
- [x] Dependency and generated directories are excluded.
- [x] TypeScript, CMake, empty, invalid-manifest, and exclusion cases are tested.

---

## Priority 3 - Context Quality and Budgeting

### 5. Use one total context budget with section-aware truncation

**Issue**

The configured maximum is independently applied to knowledge, rules, and the solution
map. The total request can therefore greatly exceed the value implied by
`nrgbot.projectContextMaxChars`. Raw character slicing can also cut a heading or project
record in half.

**Implementation prompt**

```text
Replace NRGBot's independent per-section character caps with one total project-context
budget and section-aware truncation.

Start in src/projectContext.ts, src/extension.ts getProjectContext, and the
nrgbot.projectContextMaxChars setting in package.json.

Requirements:
1. Treat projectContextMaxChars as the maximum combined size of injected knowledge,
   solution map, and applicable rules, excluding the fixed system prompt and current
   user attachment.
2. Allocate space explicitly. Prioritize curated knowledge, then high-value solution
   identity/project relationships, then lower-value packages/layout details. Include
   rules only on coding requests as today.
3. Truncate Markdown at section or paragraph boundaries and maps at complete project or
   edge records. Never slice in the middle of a record when avoidable.
4. Include a concise notice naming omitted sections or record counts.
5. Validate configuration values and define behavior for zero, negative, NaN, and very
   small budgets.
6. Keep allocation and rendering functions pure and unit tested.
7. Update package.json descriptions and documentation so the setting's semantics match
   its implementation.

Run npm run compile, focused tests, and npm run lint.
```

**Acceptance criteria**

- [x] Combined injected context stays within the configured budget.
- [x] Important identity and architecture information survives before minor details.
- [x] No project record or Markdown section is arbitrarily cut in half.
- [x] Boundary cases are tested.

### 6. Strengthen the knowledge-document template

**Issue**

The generated template asks only for purpose, architecture, entry points, and
conventions. It does not prompt maintainers to document runtime flows, terminology,
invariants, operational procedures, or authoritative source locations.

**Implementation prompt**

```text
Improve KNOWLEDGE_DOC_TEMPLATE in src/projectContext.ts so maintainers can give NRGBot
the domain context required for accurate engineering answers.

Requirements:
1. Add concise sections for purpose and users, domain glossary, component
   responsibilities, key runtime flows, entry points, invariants and constraints,
   configuration/deployment, build/test/debug commands, ownership boundaries, known
   hazards, and authoritative source paths.
2. Make comments ask for concrete facts and workspace-relative paths.
3. Tell authors to mark unknown information as unknown rather than speculate.
4. Keep the generated file approachable; use examples in comments without inserting
   fake Starfish facts.
5. Preserve the generateKnowledgeDoc behavior that never overwrites an existing file.
6. Add or update a test asserting the essential template sections.

Run npm run compile, focused tests, and npm run lint.
```

**Acceptance criteria**

- [x] The template covers domain, architecture, runtime, operations, ownership, and hazards.
- [x] Prompts request concrete facts and workspace-relative evidence paths.
- [x] Authors are told to mark unknown facts instead of speculating.
- [x] The template contains no fabricated product-specific facts.
- [x] Existing knowledge files remain untouched by the generation command.

---

## Priority 4 - Provenance, Freshness, and Workspace Scope

### 7. Distinguish curated guidance from observed code facts

**Issue**

The current grounding prompt calls both hand-authored knowledge and generated map data
authoritative. The knowledge document can be stale, while generated facts can be
incomplete. The model is not instructed how to handle conflicts.

**Implementation prompt**

```text
Make NRGBot's grounding instructions provenance-aware.

Start in src/extension.ts at GROUNDING_PREAMBLE and _buildKnowledgeTurns.

Requirements:
1. Label hand-authored knowledge as curated project intent, terminology, conventions,
   and architecture guidance.
2. Label the solution map as generated observations with source project paths.
3. State that current inspected source is authoritative for implementation details.
4. When sources conflict, require the model to describe the conflict and cite the
   relevant workspace paths rather than silently choosing one.
5. When evidence is absent, require a bounded tool lookup if tools are available;
   otherwise state the limitation.
6. Remove hard-coded product claims from generic grounding text unless they come from
   the knowledge document or generated solution data.
7. Add prompt-composition tests that assert labels, precedence, and fallback guidance.

Run npm run compile, focused tests, and npm run lint.
```

**Acceptance criteria**

- [x] Curated guidance and generated observations are labeled by provenance.
- [x] Current inspected source is authoritative for implementation details.
- [x] Conflicts must be reported with workspace-relative path evidence.
- [x] Missing evidence triggers bounded lookup or an explicit limitation.
- [x] Generic grounding prompts contain no hard-coded product or technology claims.
- [x] Prompt precedence and fallback guidance have automated tests.

### 8. Support multiple workspace roots and complete invalidation

**Issue**

Context reading assumes the first workspace folder, while solution discovery can span
all roots. Watchers omit supported project types and files that influence generated
metadata.

**Implementation prompt**

```text
Make project-context discovery and invalidation correct for multi-root workspaces.

Start in src/projectContext.ts getWorkspaceRoot/readKnowledgeDoc/generateProjectMap and
the watcher setup in src/extension.ts.

Requirements:
1. Associate each discovered solution and configured knowledge/rules document with a
   specific workspace folder.
2. Define deterministic behavior for relative knowledge paths in multi-root
   workspaces. Prefer one document per root and label each root in injected context.
3. Ensure solution-relative project paths are resolved against the owning solution,
   while displayed paths identify the workspace root without ambiguity.
4. Watch sln, csproj, vcxproj, vbproj, fsproj, shproj, Directory.Build.props,
   Directory.Build.targets, Directory.Packages.props, global.json, and configured
   knowledge/rules documents when they affect generated context.
5. Rebuild watchers when workspace folders or relevant settings change, and dispose all
   watcher subscriptions correctly.
6. Prevent stale asynchronous context generation from repopulating the cache after a
   newer invalidation. Use a generation/version guard or equivalent.
7. Add tests or a factored test harness for two workspace roots, duplicate solution
   names, edits during generation, and watcher pattern coverage.

Run npm run compile, focused tests, and npm run lint.
```

---

## Priority 5 - End-to-End Confidence

### 9. Test the context pipeline, not only parser helpers

**Issue**

Current tests cover isolated regular-expression helpers. They do not prove that files
are discovered, context is cached and refreshed, messages are ordered correctly, or the
final API request contains the expected grounding and tools.

**Implementation prompt**

```text
Add end-to-end tests for NRGBot's project-context pipeline without requiring a live
Ollama server.

Requirements:
1. Factor filesystem discovery, context assembly, routing, and request-body composition
   behind small testable functions or injected dependencies. Do not expose unrelated
   extension internals.
2. Build fixture workspaces containing a mixed C# and C++ solution, project references,
   a knowledge document, rules, and representative entry points.
3. Verify generated map content, deterministic ordering, total budgeting, and missing
   file behavior.
4. Verify cache reuse, manual invalidation, file-change invalidation, and stale-build
   protection.
5. Verify final request bodies for an ordinary architecture question, detailed source
   question, explicit file action, attached file, cross-file attached question, and
   post-tool iteration.
6. Assert that context appears once, immediately before the current question where
   applicable, and that tool schemas are present whenever exploration is allowed.
7. Use a fake transport or request-builder test; do not call a real model or network
   service.

Run npm run compile, npm test, and npm run lint. Document any behavior that cannot be
tested at the unit/integration level and provide a short manual verification checklist.
```

**Acceptance criteria**

- [ ] A regression in context discovery or request composition fails automated tests.
- [ ] Tests do not require Ollama or network access.
- [ ] Tool routing and message ordering are covered together.

---

## Optional Next Step - Question-Specific Retrieval

After the preceding issues are complete, consider lightweight lexical retrieval before
embeddings. Search project names, paths, symbols, headings, and knowledge-document terms
to select a small question-specific context block. This should complement the baseline
map and tools, not replace them.

**Implementation prompt**

```text
Design and implement bounded question-specific retrieval for NRGBot after the baseline
context, routing, budgeting, and tests are complete.

Use deterministic lexical scoring over curated knowledge sections, generated project
records, file paths, and symbol-search results. Return a small evidence block with
workspace-relative source paths. Keep read-only tools available for follow-up evidence.
Do not introduce embeddings or a vector database unless measurements on the target
solutions show lexical retrieval is inadequate.

Add relevance, determinism, budget, stale-index, and no-match tests. Include a small
evaluation set of representative architecture and implementation questions, and report
whether retrieval improves evidence selection over the baseline map alone.
```

---

## Recommended Delivery Order

1. Context routing and placement (issues 1-2).
2. Semantic solution map and fallback discovery (issues 3-4).
3. Total budgeting and knowledge template (issues 5-6).
4. Provenance and multi-root freshness (issues 7-8).
5. End-to-end context tests (issue 9, expanded alongside every earlier issue).
6. Question-specific retrieval only after the baseline pipeline is measurable.

## Manual Evaluation Questions

Use these after each delivery phase against a representative mixed C# and C++ solution:

1. What is this solution for, and who uses it?
2. What are the main projects and what does each one own?
3. Trace the dependencies from the primary executable to the native radio component.
4. Where does the application start, and what is the first important runtime flow?
5. Which projects test the gateway behavior?
6. What evidence supports that answer? List the relevant workspace paths.
7. The knowledge document says one thing but the project file says another. Which is
   current, and what should be updated?
8. What is not documented well enough to answer confidently?

A successful implementation should answer known facts with evidence, inspect the
workspace when baseline context is insufficient, identify conflicts, and explicitly
acknowledge genuine unknowns instead of inventing details.