# NRGBot — Future Improvements

Backlog from the expert review (2026-09-15). Item 7 (externalize webview script) is already done.

## Critical bugs

1. ~~HTTP/HTTPS mismatch~~ — done: `_streamFromOllama` now picks `http` or `https` based on `parsedUrl.protocol`, with the correct default port (443 vs 80).

2. ~~No HTTP status handling~~ — done: non-2xx responses now read the error body and post an `error` message to the webview instead of hanging at "Thinking...".

3. ~~Concurrent streams collide~~ — done: the extension tracks the in-flight request; the Send button turns into a Stop button while streaming (posts `stopStream`, which calls `req.destroy()`), and a second `sendPrompt` while one is active is rejected with a warning.

## Conversation & state loss

4. ~~No real multi-turn memory~~ — done: the webview now keeps a `conversation` array (user + assistant turns) and sends the full history to Ollama on every request.

5. **Webview state resets on view hide/show** — `retainContextWhenHidden` isn't set, so switching to another sidebar and back destroys chat history + pinned attachments. Either set `retainContextWhenHidden: true`, or persist via the webview's `getState()/setState()` API or an extension-side `Memento`.

## Security / robustness

6. ~~No Content-Security-Policy~~ — done as part of the webview.js externalization.

8. **Silent JSON parse failures** — the SSE parser's `catch (e) {}` hides real errors. Log unexpected parse failures (behind a debug flag) so protocol changes from the Ollama server don't fail silently.

9. **No attachment size guard** — "Full Page" on a huge file can blow past the model's context window with no warning or truncation.

## Product/UX gaps

10. No "New Chat" / clear action — history grows unbounded in the DOM.
11. No visual indication that a request is in-flight beyond "Thinking..." text (no stop/cancel, no disabled state).
12. No connection/model health check — errors only surface after a failed send.

## Code quality / testing

13. `ed.document.fileName.split(/[\\/]/).pop()` is duplicated 3 times — extract a small helper.
14. Zero test coverage for `renderMarkdown`/`stripFences` (the escaping-sensitive logic that already caused a real production bug). Add unit tests (e.g. jsdom-based) or a CI check that runs `node --check` against the rendered webview script.
15. `package.json` has no `repository` field and no command-palette commands (e.g. "NRGBot: Clear Chat").
