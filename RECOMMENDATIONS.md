# NRGBot — Implementation Recommendations

Prioritized backlog for making the extension solid for daily use. Grounded in issues
actually hit during development (leaked tool-call JSON, double code fences, invented
tools, wrong file paths).

---

## Priority 1 — Reliability

### 1.1 Extract & unit-test the parser functions
Every bug so far lived in string/stream parsing. Make these pure and testable.

- [x] Move `_extractLeadingToolCallJson` (from `src/extension.ts`) into a standalone,
      exported pure function (`src/parsing.ts`).
- [x] Move `stripFences` and `getCodeBlocks` logic into a shared, testable module
      (`src/parsing.ts`; `media/webview.js` mirrors them, kept in sync manually).
- [x] Add unit tests with fixtures for each bug already encountered (`src/test/parsing.test.ts`):
  - Leading tool-call JSON followed by prose.
  - Tool-call JSON wrapped in `<tool_call>` tags and ` ```json ` fences.
  - Double / duplicated closing code fences.
  - Trailing whitespace after the closing fence.
  - Invented / unknown tool name.
  - Truncated JSON that never closes.

### 1.2 Treat every model output as adversarial
Local models routinely emit malformed tool calls, invented tools, echoed attachments,
and truncated fences.

- [ ] Centralize model-output sanitization so fixes live in one place.
- [ ] Ensure unknown tool calls never render in chat and return a corrective tool result
      (already implemented — add a regression test).

### 1.3 Recoverable state on dropped/mid-stream failures
Remote Ollama over LAN will drop connections.

- [ ] Ensure a dropped stream mid-response leaves the chat in a recoverable state
      (no half-rendered "pending" bubble).
- [ ] Surface a visible "reconnecting / failed" indicator in the webview.

---

## Priority 2 — Daily-use ergonomics

### 2.1 Conversation persistence
- [ ] Persist the active conversation via VS Code `Memento` / webview `getState` so a
      window reload does not wipe the thread.
- [ ] Consider lightweight session history (list of past chats).

### 2.2 Model / server switching from the UI
- [ ] Add a model dropdown in the webview (config is already read in the provider).
- [ ] Allow switching `serverUrl` without hand-editing settings JSON.

### 2.3 Diff-based apply
- [ ] Replace blind "Replace Entire File" with a preview diff (`vscode.diff`) before
      applying model-generated code.
- [ ] Keep "Insert at Cursor" / "Replace Selection" but show a confirmation/diff.

### 2.4 Token / context budget indicator
- [ ] Show a running character/token estimate (there is already `MAX_ATTACHMENT_CHARS`)
      so the user knows before the context window silently truncates.

---

## Priority 3 — Security / correctness

### 3.1 Harden `readFileTool` basename fallback
- [ ] `**/<filename>` can match multiple files; currently takes `matches[0]`.
- [ ] Label which file was picked (already prefixed with the resolved path — keep it).
- [ ] Consider refusing when there are multiple matches instead of guessing.

### 3.2 Fix path-traversal check
- [ ] `resolveWorkspacePath` uses `target.fsPath.startsWith(base.fsPath)`, which is
      vulnerable to sibling-prefix escapes (e.g. `workspace` vs `workspace-evil`).
- [ ] Normalize paths and compare with a trailing separator.

---

## Priority 4 — Config polish

### 4.1 Sensible default server URL
- [ ] Default `nrgbot.serverUrl` is a hardcoded private IP; change to
      `http://localhost:11434` and document the remote setup in the README.

### 4.2 Request timeout
- [ ] Add a socket timeout to the `http.request` so a hung server does not spin forever.

---

## Suggested first sprint (highest leverage)

1. **P1.1** — Extract parser functions + unit test suite (locks in all fixes to date).
2. **P3.2** — Path-traversal hardening.
3. **P4.2** — Request timeout.
