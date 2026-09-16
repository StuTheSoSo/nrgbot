import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { TOOLS, executeTool, isKnownTool } from './tools';
import { extractLeadingToolCallJson } from './parsing';

export function activate(context: vscode.ExtensionContext) {
    const previewProvider = new ApplyPreviewProvider();
    const provider = new OllamaViewProvider(context.extensionUri, previewProvider);
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(ApplyPreviewProvider.scheme, previewProvider),
        vscode.window.registerWebviewViewProvider('ollama.chatSidebarView', provider),
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) provider.lastActiveEditor = editor;
        })
    );
    if (vscode.window.activeTextEditor) provider.lastActiveEditor = vscode.window.activeTextEditor;
}

/** Serves the proposed post-apply file content for the `vscode.diff` preview. */
class ApplyPreviewProvider implements vscode.TextDocumentContentProvider {
    public static readonly scheme = 'nrgbot-preview';
    private content = '';
    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChange = this._onDidChange.event;

    public setContent(text: string): void {
        this.content = text;
    }

    public provideTextDocumentContent(): string {
        return this.content;
    }

    public refresh(uri: vscode.Uri): void {
        this._onDidChange.fire(uri);
    }
}

class OllamaViewProvider implements vscode.WebviewViewProvider {
    private static readonly MAX_ATTACHMENT_CHARS = 50000;

    public lastActiveEditor: vscode.TextEditor | undefined;
    private activeRequest: http.ClientRequest | undefined;
    private streamAborted = false;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly previewProvider: ApplyPreviewProvider
    ) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
        const scriptUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.js'));
        const csp = `default-src 'none'; style-src ${webviewView.webview.cspSource} 'unsafe-inline'; script-src ${webviewView.webview.cspSource};`;

        webviewView.webview.html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <style>
        /* Flexbox configuration pushes all active utility triggers to the very bottom window panel */
        html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; background: var(--vscode-sidebar-background); }
        body { display: flex; flex-direction: column; font-family: sans-serif; box-sizing: border-box; padding: 10px; color: var(--vscode-editor-foreground); }
        
        /* Chat box dynamically consumes all available top vertical screen space */
        #chat-box { flex: 1; overflow-y: auto; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); padding: 5px; margin-bottom: 10px; }
        
        .msg { margin: 8px 0; padding: 6px; border-radius: 4px; }
        .user { background: var(--vscode-button-background); color: var(--vscode-button-foreground); white-space: pre-wrap; }
        .ai { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); }
        .ai p, .ai ul, .ai ol { margin: 0.4em 0; }
        .ai code { font-family: var(--vscode-editor-font-family, monospace); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
        .ai pre { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; overflow-x: auto; margin: 0; }
        .ai pre code { padding: 0; background: none; }
        .ai h1, .ai h2, .ai h3 { margin: 0.5em 0 0.3em; }
        .md-table { border-collapse: collapse; margin: 0.5em 0; font-size: 0.9em; max-width: 100%; display: block; overflow-x: auto; }
        .md-table th, .md-table td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; text-align: left; }
        .md-table th { background: var(--vscode-textBlockQuote-background); font-weight: 600; }
        .code-block { margin: 0.4em 0; }
        .code-actions { display: flex; gap: 4px; margin-bottom: 2px; }
        .code-actions button { width: auto; margin: 0; padding: 2px 8px; font-size: 0.8em; }
        .ai.pending { opacity: 0.7; animation: nrgbot-pulse 1.2s ease-in-out infinite; }
        @keyframes nrgbot-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
        .tool-note { font-size: 0.8em; opacity: 0.75; font-family: var(--vscode-editor-font-family, monospace); margin: 2px 0; }
        .stream-status.failed { margin-top: 6px; padding: 4px 6px; border-radius: 3px; font-size: 0.85em; color: var(--vscode-inputValidation-warningForeground, var(--vscode-editor-foreground)); background: var(--vscode-inputValidation-warningBackground, rgba(181, 137, 0, 0.15)); border: 1px solid var(--vscode-inputValidation-warningBorder, #b58900); }
        
        /* Fixed bottom tray container formatting profiles */
        .bottom-tray { display: flex; flex-direction: column; width: 100%; }
        textarea { width: 100%; height: 60px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); resize: none; box-sizing: border-box; }
        button { width: 100%; margin-top: 5px; padding: 6px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        #send-btn.stop-mode { background: var(--vscode-inputValidation-warningBackground, #b58900); }
        .btn-group { display: flex; gap: 5px; margin-bottom: 5px; }
        .top-bar { display: flex; justify-content: flex-end; gap: 5px; margin-bottom: 5px; }
        .top-bar button { width: auto; margin: 0; padding: 2px 8px; font-size: 0.8em; }
        .settings-panel { border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); padding: 8px; margin-bottom: 8px; border-radius: 4px; }
        .settings-label { display: block; font-size: 0.75em; opacity: 0.8; margin: 4px 0 2px; text-transform: uppercase; letter-spacing: 0.03em; }
        .settings-row { display: flex; gap: 4px; align-items: center; }
        .settings-row input, .settings-row select { flex: 1; min-width: 0; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 3px 4px; box-sizing: border-box; font-size: 0.85em; }
        .settings-row button { width: auto; margin: 0; padding: 3px 8px; font-size: 0.85em; flex: 0 0 auto; }
        .settings-status { font-size: 0.75em; margin-top: 5px; min-height: 1em; opacity: 0.85; }
        .settings-status.error { color: var(--vscode-inputValidation-warningForeground, #b58900); }
    </style>
</head>
<body>
    <!-- The conversation thread element stays pinned natively on top -->
    <div class="top-bar">
        <button id="settings-btn">⚙️ Settings</button>
        <button id="clear-btn">🗑️ New Chat</button>
    </div>
    <div id="settings-panel" class="settings-panel" style="display:none;">
        <label class="settings-label" for="server-url">Server URL</label>
        <div class="settings-row">
            <input id="server-url" type="text" placeholder="http://localhost:11434" />
            <button id="connect-btn" title="Connect &amp; refresh models">🔌 Connect</button>
        </div>
        <label class="settings-label" for="model-select">Model</label>
        <div class="settings-row">
            <select id="model-select"></select>
            <button id="refresh-models-btn" title="Refresh model list">↻</button>
        </div>
        <div id="settings-status" class="settings-status"></div>
    </div>
    <div id="chat-box"></div>

    <!-- All active interface controllers are grouped safely at the bottom margin layout -->
    <div class="bottom-tray">
        <div id="attachments" class="btn-group" style="flex-wrap:wrap;"></div>
        <div class="btn-group">
            <button id="grab-btn" style="flex:1;">✨ Selection</button>
            <button id="page-btn" style="flex:1;">📄 Full Page</button>
        </div>
        <textarea id="prompt" placeholder="Ask your remote Ollama..."></textarea>
        <button id="send-btn">Send to Remote Machine</button>
    </div>

    <script src="${scriptUri}"></script>
</body>
</html>`;

        webviewView.webview.onDidReceiveMessage(async (data) => {
            if (data.type === 'sendPrompt') {
                this._streamFromOllama(data.value, webviewView.webview);
            } else if (data.type === 'stopStream') {
                if (this.activeRequest) {
                    this.streamAborted = true;
                    this.activeRequest.destroy();
                    this.activeRequest = undefined;
                }
            } else if (data.type === 'grabText') {
                const ed = this.lastActiveEditor ?? vscode.window.activeTextEditor;
                if (ed) {
                    const fileName = vscode.workspace.asRelativePath(ed.document.uri);
                    const content = await this._confirmAttachmentSize(ed.document.getText(ed.selection), 'Selection');
                    if (content !== undefined) {
                        webviewView.webview.postMessage({ type: 'attach', label: `✨ ${fileName} (selection)`, fileName, value: content });
                    }
                } else {
                    vscode.window.showWarningMessage('NRGBot: No editor found to grab text from.');
                }
            } else if (data.type === 'grabPage') {
                const ed = this.lastActiveEditor ?? vscode.window.activeTextEditor;
                if (ed) {
                    const fileName = vscode.workspace.asRelativePath(ed.document.uri);
                    const content = await this._confirmAttachmentSize(ed.document.getText(), 'Full page');
                    if (content !== undefined) {
                        webviewView.webview.postMessage({ type: 'attach', label: `📄 ${fileName}`, fileName, value: content });
                    }
                } else {
                    vscode.window.showWarningMessage('NRGBot: No editor found to grab the page from.');
                }
            } else if (data.type === 'applyCode') {
                await this._applyCodeWithPreview(data.value);
            } else if (data.type === 'getModels') {
                await this._sendModelList(webviewView.webview);
            } else if (data.type === 'setModel') {
                if (typeof data.value === 'string' && data.value) {
                    await vscode.workspace.getConfiguration('nrgbot')
                        .update('modelName', data.value, vscode.ConfigurationTarget.Global);
                }
            } else if (data.type === 'setServerUrl') {
                if (typeof data.value === 'string' && data.value.trim()) {
                    await vscode.workspace.getConfiguration('nrgbot')
                        .update('serverUrl', data.value.trim(), vscode.ConfigurationTarget.Global);
                    await this._sendModelList(webviewView.webview);
                }
            }
        });
    }

    private async _sendModelList(webview: vscode.Webview): Promise<void> {
        const config = vscode.workspace.getConfiguration('nrgbot');
        const serverUrl = config.get<string>('serverUrl') || 'http://192.168.3.142:11434';
        const current = config.get<string>('modelName') || '';
        const result = await this._fetchModels(serverUrl);
        webview.postMessage({
            type: 'models',
            models: result.models,
            current,
            serverUrl,
            error: result.error
        });
    }

    private _fetchModels(serverUrl: string): Promise<{ models: string[]; error?: string }> {
        return new Promise((resolve) => {
            let parsedUrl: URL;
            try {
                parsedUrl = new URL(serverUrl);
            } catch {
                resolve({ models: [], error: 'Invalid server URL.' });
                return;
            }

            const isHttps = parsedUrl.protocol === 'https:';
            const transport = isHttps ? https : http;
            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (isHttps ? 443 : 80),
                path: '/api/tags',
                method: 'GET'
            };

            const req = transport.request(options, (res) => {
                let body = '';
                res.on('data', chunk => { body += chunk.toString(); });
                res.on('end', () => {
                    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                        resolve({ models: [], error: this._describeHttpError(res.statusCode, res.statusMessage, body) });
                        return;
                    }
                    try {
                        const parsed = JSON.parse(body);
                        const models = Array.isArray(parsed?.models)
                            ? parsed.models
                                .map((m: { name?: string }) => m?.name)
                                .filter((n: unknown): n is string => typeof n === 'string')
                            : [];
                        resolve({ models });
                    } catch {
                        resolve({ models: [], error: 'Could not parse the model list from the server.' });
                    }
                });
            });
            req.on('error', (e) => {
                resolve({ models: [], error: this._describeConnectionError(e as NodeJS.ErrnoException, serverUrl) });
            });
            req.setTimeout(5000, () => {
                req.destroy();
                resolve({ models: [], error: 'The server did not respond in time.' });
            });
            req.end();
        });
    }

    private async _applyCodeWithPreview(code: string): Promise<void> {
        const ed = this.lastActiveEditor ?? vscode.window.activeTextEditor;
        if (!ed) {
            vscode.window.showWarningMessage('No active editor to apply changes to.');
            return;
        }

        const fileName = ed.document.fileName.split(/[\\/]/).pop() || 'file';
        const hasSelection = !ed.selection.isEmpty;
        const options: string[] = hasSelection
            ? ['Replace Selection', 'Insert at Cursor', 'Replace Entire File']
            : ['Insert at Cursor', 'Replace Entire File'];
        const choice = await vscode.window.showQuickPick(options, {
            title: `Apply code to ${fileName}`,
            placeHolder: 'Choose how to apply this code'
        });
        if (!choice) return;

        // Snapshot the document and build both the proposed full text (for the diff)
        // and a WorkspaceEdit (applied only on confirm, so focus can move to the diff).
        const targetUri = ed.document.uri;
        const original = ed.document.getText();
        const edit = new vscode.WorkspaceEdit();
        let proposed: string;

        if (choice === 'Replace Entire File') {
            proposed = code;
            const fullRange = new vscode.Range(
                ed.document.positionAt(0),
                ed.document.positionAt(original.length)
            );
            edit.replace(targetUri, fullRange, code);
        } else if (choice === 'Replace Selection') {
            const start = ed.document.offsetAt(ed.selection.start);
            const end = ed.document.offsetAt(ed.selection.end);
            proposed = original.slice(0, start) + code + original.slice(end);
            edit.replace(targetUri, new vscode.Range(ed.selection.start, ed.selection.end), code);
        } else {
            const offset = ed.document.offsetAt(ed.selection.active);
            proposed = original.slice(0, offset) + code + original.slice(offset);
            edit.insert(targetUri, ed.selection.active, code);
        }

        // Preview the result as a diff against the current file.
        this.previewProvider.setContent(proposed);
        const previewUri = vscode.Uri.from({ scheme: ApplyPreviewProvider.scheme, path: `/Proposed ${fileName}` });
        this.previewProvider.refresh(previewUri);
        await vscode.commands.executeCommand(
            'vscode.diff',
            targetUri,
            previewUri,
            `${fileName} \u2194 Proposed (${choice})`,
            { preview: true }
        );

        const confirm = await vscode.window.showInformationMessage(
            `Review the diff, then apply "${choice}" to ${fileName}?`,
            'Apply',
            'Cancel'
        );
        if (confirm === 'Apply') {
            await vscode.workspace.applyEdit(edit);
        }
    }

    private async _confirmAttachmentSize(text: string, label: string): Promise<string | undefined> {
        if (text.length <= OllamaViewProvider.MAX_ATTACHMENT_CHARS) return text;

        const approxTokens = Math.round(text.length / 4);
        const truncateOption = `Attach Truncated (first ${OllamaViewProvider.MAX_ATTACHMENT_CHARS.toLocaleString()} chars)`;
        const choice = await vscode.window.showWarningMessage(
            `${label} is ${text.length.toLocaleString()} characters (~${approxTokens.toLocaleString()} tokens), which may exceed the model's context window.`,
            'Attach Anyway',
            truncateOption,
            'Cancel'
        );
        if (!choice || choice === 'Cancel') return undefined;
        if (choice === truncateOption) {
            return text.slice(0, OllamaViewProvider.MAX_ATTACHMENT_CHARS) + '\n\n... [truncated]';
        }
        return text;
    }

    private static readonly MAX_AGENT_ITERATIONS = 6;

    private async _streamFromOllama(
        messages: { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }[],
        webview: vscode.Webview,
        depth = 0
    ): Promise<void> {
        if (depth >= OllamaViewProvider.MAX_AGENT_ITERATIONS) {
            webview.postMessage({ type: 'error', value: 'Stopped: too many tool-call iterations.' });
            return;
        }

        const config = vscode.workspace.getConfiguration('nrgbot');
        const toolsEnabled = config.get<boolean>('enableTools') ?? true;

        const result = await this._postChatCompletion(messages, webview, toolsEnabled);
        if (!result) return; // error or abort already reported

        if (result.toolCalls.length === 0) {
            webview.postMessage({ type: 'done' });
            return;
        }

        const nextMessages = [...messages, {
            role: 'assistant',
            content: result.content || null,
            tool_calls: result.toolCalls.map(tc => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments }
            }))
        }];

        for (const tc of result.toolCalls) {
            let args: Record<string, unknown> = {};
            try {
                args = tc.arguments ? JSON.parse(tc.arguments) : {};
            } catch {
                // Malformed arguments JSON from the model; execute with empty args, tool reports its own error.
            }
            const supportedTool = isKnownTool(tc.name);
            if (supportedTool) {
                webview.postMessage({ type: 'toolCall', name: tc.name, args: tc.arguments });
            }
            // executeTool returns the corrective message for unknown tools, so no separate branch is needed.
            const toolResult = await executeTool(tc.name, args);
            nextMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
        }

        await this._streamFromOllama(nextMessages, webview, depth + 1);
    }

    private _postChatCompletion(
        messages: { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }[],
        webview: vscode.Webview,
        toolsEnabled: boolean
    ): Promise<{ content: string; toolCalls: { id: string; name: string; arguments: string }[] } | null> {
        return new Promise((resolve) => {
            if (this.activeRequest) {
                vscode.window.showWarningMessage('NRGBot: A response is already in progress.');
                resolve(null);
                return;
            }

            const config = vscode.workspace.getConfiguration('nrgbot');
            const configuredUrl = config.get<string>('serverUrl') || 'http://192.168.3.142:11434';
            const modelName = config.get<string>('modelName') || 'qwen2.5-coder:7b';

            let parsedUrl: URL;
            try {
                parsedUrl = new URL(configuredUrl);
            } catch (err) {
                parsedUrl = new URL('http://192.168.3.142:11434');
            }

            const isHttps = parsedUrl.protocol === 'https:';
            const transport = isHttps ? https : http;

            const systemMessage = {
                role: 'system',
                content: 'You are a coding assistant inside VS Code. The user\'s message may already include attached file content in fenced code blocks, each preceded by a line like "Attached file: <name>". That attached content IS the file the user is referring to; treat it as fully available and answer from it directly. Never call read_file or list_directory for a file whose content is already attached, and never claim an attached file does not exist. Do not echo or quote the complete attached file unless the user explicitly asks for it. Never write JSON tool calls in your response. Only call tools supplied in this request; never invent a tool such as analyze_code_quality. Analyze attached code directly in your normal response.'
            };
            const postData = JSON.stringify({
                model: modelName,
                messages: [systemMessage, ...messages],
                stream: true,
                ...(toolsEnabled ? { tools: TOOLS } : {})
            });

            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (isHttps ? 443 : 80),
                path: '/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            this.streamAborted = false;
            let content = '';
            const toolCallAccum = new Map<number, { id: string; name: string; arguments: string }>();

            let settled = false;
            const finish = (value: { content: string; toolCalls: { id: string; name: string; arguments: string }[] } | null) => {
                if (settled) return;
                settled = true;
                this.activeRequest = undefined;
                resolve(value);
            };

            const req = transport.request(options, (res) => {
                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                    let errorBody = '';
                    res.on('data', chunk => { errorBody += chunk.toString(); });
                    res.on('end', () => {
                        webview.postMessage({ type: 'error', value: this._describeHttpError(res.statusCode, res.statusMessage, errorBody) });
                        finish(null);
                    });
                    return;
                }

                let buffer = '';
                let displayBuffer = '';
                let jsonPrefixDecided = false;
                const MAX_JSON_PROBE_CHARS = 4000;
                res.on('data', (chunk) => {
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    for (const line of lines) {
                        if (line.trim().startsWith('data: ')) {
                            const payload = line.trim().substring(6);
                            if (payload === '[DONE]') continue;
                            try {
                                const json = JSON.parse(payload);
                                const delta = json.choices?.[0]?.delta;
                                if (delta?.content) {
                                    content += delta.content;
                                    if (jsonPrefixDecided) {
                                        webview.postMessage({ type: 'token', value: delta.content });
                                    } else {
                                        displayBuffer += delta.content;
                                        const probe = displayBuffer.replace(/^\s+/, '');
                                        const looksLikeToolCallStart = probe.length === 0
                                            || probe.startsWith('{')
                                            || '<tool_call>'.startsWith(probe.slice(0, 11))
                                            || '```json'.startsWith(probe.slice(0, 7))
                                            || probe === '`' || probe === '``';
                                        if (!looksLikeToolCallStart) {
                                            jsonPrefixDecided = true;
                                            webview.postMessage({ type: 'token', value: displayBuffer });
                                            displayBuffer = '';
                                        } else {
                                            const leading = extractLeadingToolCallJson(displayBuffer);
                                            if (leading) {
                                                jsonPrefixDecided = true;
                                                if (leading.rest) webview.postMessage({ type: 'token', value: leading.rest });
                                                displayBuffer = '';
                                            } else if (displayBuffer.length > MAX_JSON_PROBE_CHARS) {
                                                // Gave up waiting for a closing brace; show it rather than hide real content forever.
                                                jsonPrefixDecided = true;
                                                webview.postMessage({ type: 'token', value: displayBuffer });
                                                displayBuffer = '';
                                            }
                                        }
                                    }
                                }
                                if (delta?.tool_calls) {
                                    for (const tc of delta.tool_calls) {
                                        const idx = tc.index ?? 0;
                                        const acc = toolCallAccum.get(idx) ?? { id: '', name: '', arguments: '' };
                                        if (tc.id) acc.id = tc.id;
                                        if (tc.function?.name) acc.name += tc.function.name;
                                        if (tc.function?.arguments) acc.arguments += tc.function.arguments;
                                        toolCallAccum.set(idx, acc);
                                    }
                                }
                            } catch (e) {
                                console.error('[NRGBot] Failed to parse SSE line:', line, e);
                            }
                        }
                    }
                });
                res.on('end', () => {
                    if (!jsonPrefixDecided && displayBuffer) {
                        // Never resolved into a full tool-call JSON blob (e.g. truncated); show it rather than dropping it.
                        webview.postMessage({ type: 'token', value: displayBuffer });
                    }
                    let toolCalls = [...toolCallAccum.values()].filter(tc => tc.name);
                    // Some models write a tool call as plain JSON text (sometimes followed by their real answer)
                    // instead of using the tool_calls delta, or echo the call back before/alongside their answer.
                    const leading = extractLeadingToolCallJson(content);
                    if (leading) {
                        if (toolCalls.length === 0 && leading.rest.trim() === '') {
                            toolCalls = [{ id: `fallback-${Date.now()}`, name: leading.name, arguments: leading.arguments }];
                            content = '';
                        } else {
                            content = leading.rest;
                        }
                    }
                    finish({ content, toolCalls });
                });

                // A socket drop after headers emits 'aborted'/'error'/'close' but never 'end',
                // which would otherwise leave the request hung and the chat stuck "pending".
                const handleMidStreamDrop = (err?: Error) => {
                    if (settled) return;
                    if (this.streamAborted) { finish(null); return; }
                    if (!jsonPrefixDecided && displayBuffer) {
                        webview.postMessage({ type: 'token', value: displayBuffer });
                        displayBuffer = '';
                    }
                    const detail = err
                        ? this._describeConnectionError(err as NodeJS.ErrnoException, configuredUrl)
                        : 'The connection closed before the response finished.';
                    webview.postMessage({ type: 'streamError', value: detail });
                    finish(null);
                };
                res.on('aborted', () => handleMidStreamDrop());
                res.on('error', (err) => handleMidStreamDrop(err));
                res.on('close', () => handleMidStreamDrop());
            });

            req.on('error', (e) => {
                if (this.streamAborted) {
                    finish(null);
                    return;
                }
                const friendly = this._describeConnectionError(e, configuredUrl);
                // If tokens already streamed, treat it as a recoverable mid-stream drop rather than a hard error.
                webview.postMessage({ type: content.length > 0 ? 'streamError' : 'error', value: friendly });
                if (content.length === 0) {
                    vscode.window.showErrorMessage('NRGBot Connection Failure: ' + friendly);
                }
                finish(null);
            });

            this.activeRequest = req;
            req.write(postData);
            req.end();
        });
    }

    /** Turns a non-2xx HTTP response into a short, actionable message instead of a raw status/body dump. */
    private _describeHttpError(statusCode: number | undefined, statusMessage: string | undefined, body: string): string {
        try {
            const parsed = JSON.parse(body);
            if (typeof parsed?.error === 'string') return parsed.error;
            if (typeof parsed?.error?.message === 'string') return parsed.error.message;
        } catch {
            // Body wasn't JSON; fall through to a generic message.
        }
        if (statusCode === 404) return `Model or endpoint not found (HTTP 404). Check the model name and server URL in NRGBot settings.`;
        if (statusCode === 401 || statusCode === 403) return `The server rejected the request (HTTP ${statusCode}). Check any required authentication.`;
        if (statusCode && statusCode >= 500) return `The Ollama server had an internal error (HTTP ${statusCode}). Check the server logs.`;
        return `HTTP ${statusCode}: ${body.slice(0, 300) || statusMessage || 'Unknown error'}`;
    }

    /** Maps common Node network error codes to plain-language explanations. */
    private _describeConnectionError(e: NodeJS.ErrnoException, url: string): string {
        switch (e.code) {
            case 'ECONNREFUSED': return `Could not connect to the Ollama server at ${url}. Make sure it's running and reachable.`;
            case 'ENOTFOUND': return `Could not resolve the host in ${url}. Check the server URL in NRGBot settings.`;
            case 'ETIMEDOUT': return `Connection to ${url} timed out. The server may be unreachable or overloaded.`;
            case 'ECONNRESET': return `The connection to ${url} was reset while waiting for a response.`;
            default: return e.message;
        }
    }
}
