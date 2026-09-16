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

- [x] Centralize model-output sanitization so fixes live in one place
      (`isKnownTool` / `unknownToolResult` in `src/tools.ts`; `executeTool` returns the
      corrective message for unknown tools).
- [x] Ensure unknown tool calls never render in chat and return a corrective tool result
      (regression tests in `src/test/tools.test.ts`).

### 1.3 Recoverable state on dropped/mid-stream failures
Remote Ollama over LAN will drop connections.

- [x] Ensure a dropped stream mid-response leaves the chat in a recoverable state
      (no half-rendered "pending" bubble). The completion promise now settles exactly once
      via a `finish()` guard, and `res` `aborted`/`error`/`close` handlers catch socket
      drops after headers so the request can no longer hang.
- [x] Surface a visible "failed" indicator in the webview. On a mid-stream drop the
      partial response is preserved (kept in the transcript) and a `.stream-status.failed`
      note is appended. Note: a streamed completion cannot be resumed, so this is a clear
      failed indicator rather than a fake "reconnecting" state.

---

## Priority 2 — Daily-use ergonomics

### 2.1 Conversation persistence
- [x] Persist the active conversation via VS Code `Memento` / webview `getState` so a
      window reload does not wipe the thread. The webview now saves `conversation` +
      `attachments` via `setState` on every mutation (send, done, stop, error, attach,
      detach, clear) and rebuilds the chat DOM from `getState` on load. User turns store a
      `display` field so the restored bubble shows the typed text, not the attachment blob.
- [ ] Consider lightweight session history (list of past chats). Deferred — this is a
      larger multi-thread feature; only the single active thread is persisted so far.

### 2.2 Model / server switching from the UI
- [x] Add a model dropdown in the webview (config is already read in the provider).
      A ⚙️ Settings panel now shows a model `<select>` populated live from the server's
      `/api/tags` endpoint (proxied through the extension since the webview has no network
      access); picking one persists `nrgbot.modelName`.
- [x] Allow switching `serverUrl` without hand-editing settings JSON. The settings panel
      has a Server URL field + Connect button that persists `nrgbot.serverUrl` and
      re-fetches the model list, with inline status/error feedback.

### 2.3 Diff-based apply
- [x] Replace blind "Replace Entire File" with a preview diff (`vscode.diff`) before
      applying model-generated code. A virtual `nrgbot-preview:` document holds the
      proposed post-apply text and is diffed against the real file.
- [x] Keep "Insert at Cursor" / "Replace Selection" but show a confirmation/diff. All
      three modes now open the same diff preview and gate the edit behind an
      Apply/Cancel prompt; the edit is applied via `WorkspaceEdit` so it works even
      after focus moves to the diff editor.

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
