import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';

export function activate(context: vscode.ExtensionContext) {
    const provider = new OllamaViewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('ollama.chatSidebarView', provider),
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) provider.lastActiveEditor = editor;
        })
    );
    if (vscode.window.activeTextEditor) provider.lastActiveEditor = vscode.window.activeTextEditor;
}

class OllamaViewProvider implements vscode.WebviewViewProvider {
    private static readonly MAX_ATTACHMENT_CHARS = 50000;

    public lastActiveEditor: vscode.TextEditor | undefined;
    private activeRequest: http.ClientRequest | undefined;
    private streamAborted = false;

    constructor(private readonly extensionUri: vscode.Uri) {}

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
        
        /* Fixed bottom tray container formatting profiles */
        .bottom-tray { display: flex; flex-direction: column; width: 100%; }
        textarea { width: 100%; height: 60px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); resize: none; box-sizing: border-box; }
        button { width: 100%; margin-top: 5px; padding: 6px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        #send-btn.stop-mode { background: var(--vscode-inputValidation-warningBackground, #b58900); }
        .btn-group { display: flex; gap: 5px; margin-bottom: 5px; }
        .top-bar { display: flex; justify-content: flex-end; margin-bottom: 5px; }
        .top-bar button { width: auto; margin: 0; padding: 2px 8px; font-size: 0.8em; }
    </style>
</head>
<body>
    <!-- The conversation thread element stays pinned natively on top -->
    <div class="top-bar">
        <button id="clear-btn">🗑️ New Chat</button>
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
                    const fileName = ed.document.fileName.split(/[\\/]/).pop();
                    const content = await this._confirmAttachmentSize(ed.document.getText(ed.selection), 'Selection');
                    if (content !== undefined) {
                        webviewView.webview.postMessage({ type: 'attach', label: `✨ ${fileName} (selection)`, value: content });
                    }
                } else {
                    vscode.window.showWarningMessage('NRGBot: No editor found to grab text from.');
                }
            } else if (data.type === 'grabPage') {
                const ed = this.lastActiveEditor ?? vscode.window.activeTextEditor;
                if (ed) {
                    const fileName = ed.document.fileName.split(/[\\/]/).pop();
                    const content = await this._confirmAttachmentSize(ed.document.getText(), 'Full page');
                    if (content !== undefined) {
                        webviewView.webview.postMessage({ type: 'attach', label: `📄 ${fileName}`, value: content });
                    }
                } else {
                    vscode.window.showWarningMessage('NRGBot: No editor found to grab the page from.');
                }
            } else if (data.type === 'applyCode') {
                const ed = this.lastActiveEditor ?? vscode.window.activeTextEditor;
                if (!ed) {
                    vscode.window.showWarningMessage('No active editor to apply changes to.');
                    return;
                }
                const fileName = ed.document.fileName.split(/[\\/]/).pop();
                const hasSelection = !ed.selection.isEmpty;
                const options: string[] = hasSelection
                    ? ['Replace Selection', 'Insert at Cursor', 'Replace Entire File']
                    : ['Insert at Cursor', 'Replace Entire File'];
                const choice = await vscode.window.showQuickPick(options, {
                    title: `Apply code to ${fileName}`,
                    placeHolder: 'Choose how to apply this code'
                });
                if (!choice) return;

                if (choice === 'Replace Entire File') {
                    const fullRange = new vscode.Range(
                        ed.document.positionAt(0),
                        ed.document.positionAt(ed.document.getText().length)
                    );
                    await ed.edit(editBuilder => editBuilder.replace(fullRange, data.value));
                } else if (choice === 'Replace Selection') {
                    await ed.edit(editBuilder => editBuilder.replace(ed.selection, data.value));
                } else {
                    await ed.edit(editBuilder => editBuilder.insert(ed.selection.active, data.value));
                }
            }
        });
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

    private _streamFromOllama(messages: { role: string; content: string }[], webview: vscode.Webview) {
        if (this.activeRequest) {
            vscode.window.showWarningMessage('NRGBot: A response is already in progress.');
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

        const postData = JSON.stringify({
            model: modelName,
            messages,
            stream: true
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
        const req = transport.request(options, (res) => {
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                let errorBody = '';
                res.on('data', chunk => { errorBody += chunk.toString(); });
                res.on('end', () => {
                    this.activeRequest = undefined;
                    webview.postMessage({ type: 'error', value: `HTTP ${res.statusCode}: ${errorBody.slice(0, 300) || res.statusMessage}` });
                });
                return;
            }

            let buffer = '';
            res.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (line.trim().startsWith('data: ')) {
                        try {
                            const json = JSON.parse(line.trim().substring(6));
                            if (json.choices && json.choices[0] && json.choices[0].delta) {
                                const content = json.choices[0].delta.content || '';
                                if (content) webview.postMessage({ type: 'token', value: content });
                            }
                        } catch (e) {
                            console.error('[NRGBot] Failed to parse SSE line:', line, e);
                        }
                    }
                }
            });
            res.on('end', () => {
                this.activeRequest = undefined;
                webview.postMessage({ type: 'done' });
            });
        });
        
        req.on('error', (e) => { 
            this.activeRequest = undefined;
            if (this.streamAborted) return;
            webview.postMessage({ type: 'error', value: e.message }); 
            vscode.window.showErrorMessage('NRGBot Connection Failure: ' + e.message);
        });
        
        this.activeRequest = req;
        req.write(postData);
        req.end();
    }
}
