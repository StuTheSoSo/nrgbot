import * as vscode from 'vscode';
import * as http from 'http';

export function activate(context: vscode.ExtensionContext) {
    const provider = new OllamaViewProvider();
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('ollama.chatSidebarView', provider),
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) provider.lastActiveEditor = editor;
        })
    );
    if (vscode.window.activeTextEditor) provider.lastActiveEditor = vscode.window.activeTextEditor;
}

class OllamaViewProvider implements vscode.WebviewViewProvider {
    public lastActiveEditor: vscode.TextEditor | undefined;

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        webviewView.webview.options = { enableScripts: true };
        
        webviewView.webview.html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
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
        .code-block { margin: 0.4em 0; }
        .code-actions { display: flex; gap: 4px; margin-bottom: 2px; }
        .code-actions button { width: auto; margin: 0; padding: 2px 8px; font-size: 0.8em; }
        
        /* Fixed bottom tray container formatting profiles */
        .bottom-tray { display: flex; flex-direction: column; width: 100%; }
        textarea { width: 100%; height: 60px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); resize: none; box-sizing: border-box; }
        button { width: 100%; margin-top: 5px; padding: 6px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        .btn-group { display: flex; gap: 5px; margin-bottom: 5px; }
    </style>
</head>
<body>
    <!-- The conversation thread element stays pinned natively on top -->
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

    <script>
        const vscode = acquireVsCodeApi();
        const chatBox = document.getElementById('chat-box');
        const promptInput = document.getElementById('prompt');
        const attachmentsEl = document.getElementById('attachments');
        let currentAi = null;
        let currentAiRaw = '';
        let attachments = [];

        function escapeHtml(s) {
            return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        function renderMarkdown(md) {
            const codeBlocks = [];
            let text = md.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (m, lang, code) => {
                codeBlocks.push(
                    '<div class="code-block"><div class="code-actions">' +
                    '<button class="apply-btn">\ud83d\udcdd Apply to Editor</button>' +
                    '<button class="copy-btn">\ud83d\udccb Copy</button></div>' +
                    '<pre><code>' + escapeHtml(code.replace(/\\n$/, '')) + '</code></pre></div>'
                );
                return '\\u0000' + (codeBlocks.length - 1) + '\\u0000';
            });

            text = escapeHtml(text);
            text = text.replace(/^### (.*)$/gm, '<h3>$1</h3>');
            text = text.replace(/^## (.*)$/gm, '<h2>$1</h2>');
            text = text.replace(/^# (.*)$/gm, '<h1>$1</h1>');
            text = text.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
            text = text.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
            text = text.replace(/^\\s*[-*] (.*)$/gm, '<li>$1</li>');
            text = text.replace(/(<li>[\\s\\S]*?<\\/li>\\n?)+/g, (m) => '<ul>' + m + '</ul>');
            text = text.split(/\\n{2,}/).map(block => {
                if (/^<(h\\d|ul|pre)/.test(block.trim()) || block.indexOf('\\u0000') === 0) return block;
                return '<p>' + block.replace(/\\n/g, '<br>') + '</p>';
            }).join('');

            text = text.replace(/\\u0000(\\d+)\\u0000/g, (m, i) => codeBlocks[Number(i)]);
            return text;
        }

        function stripFences(raw) {
            const m = raw.trim().match(/^\`\`\`[a-zA-Z]*\\n([\\s\\S]*?)\\n?\`\`\`$/);
            return m ? m[1] : raw;
        }

        function renderAttachments() {
            attachmentsEl.innerHTML = '';
            attachments.forEach((att, i) => {
                const chip = document.createElement('span');
                chip.style.cssText = 'background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);padding:2px 6px;border-radius:10px;font-size:0.85em;';
                chip.textContent = '\ud83d\udccc ' + att.label + ' \u2715';
                chip.title = 'Pinned to every message \u2014 click to detach';
                chip.style.cursor = 'pointer';
                chip.addEventListener('click', () => { attachments.splice(i, 1); renderAttachments(); });
                attachmentsEl.appendChild(chip);
            });
        }

        document.getElementById('send-btn').addEventListener('click', () => {
            const text = promptInput.value.trim();
            if (!text && attachments.length === 0) return;
            chatBox.innerHTML += '<div class="msg user">' + escapeHtml(text) + '</div>';

            let fullPrompt = text;
            if (attachments.length) {
                fullPrompt += '\\n\\n' + attachments.map(a => '\`\`\`\\n' + a.value + '\\n\`\`\`').join('\\n\\n');
            }

            promptInput.value = '';
            currentAi = document.createElement('div');
            currentAi.className = 'msg ai';
            currentAiRaw = '';
            currentAi.innerText = 'Thinking...';
            chatBox.appendChild(currentAi);
            chatBox.scrollTop = chatBox.scrollHeight;
            vscode.postMessage({ type: 'sendPrompt', value: fullPrompt });
        });

        promptInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                document.getElementById('send-btn').click();
            }
        });

        document.getElementById('grab-btn').addEventListener('click', () => {
            attachmentsEl.textContent = 'Grabbing selection...';
            vscode.postMessage({ type: 'grabText' });
        });
        document.getElementById('page-btn').addEventListener('click', () => {
            attachmentsEl.textContent = 'Grabbing full page...';
            vscode.postMessage({ type: 'grabPage' });
        });

        chatBox.addEventListener('click', (e) => {
            const btn = e.target.closest('.apply-btn, .copy-btn');
            if (!btn) return;
            const code = btn.closest('.code-block').querySelector('code').textContent;
            if (btn.classList.contains('apply-btn')) {
                vscode.postMessage({ type: 'applyCode', value: code });
            } else {
                navigator.clipboard.writeText(code);
            }
        });

        window.addEventListener('message', event => {
            const msg = event.data;
            console.log('[NRGBot] received message', msg.type, msg);
            if (msg.type === 'token') {
                currentAiRaw += msg.value;
                currentAi.innerHTML = renderMarkdown(currentAiRaw);
                chatBox.scrollTop = chatBox.scrollHeight;
            } else if (msg.type === 'attach') {
                attachments.push({ label: msg.label, value: msg.value });
                renderAttachments();
            } else if (msg.type === 'error') {
                currentAi.innerText = 'Error: ' + msg.value;
            } else if (msg.type === 'done') {
                if (currentAi && currentAiRaw) {
                    const footer = document.createElement('div');
                    footer.className = 'code-actions';
                    footer.style.marginTop = '6px';
                    const applyAllBtn = document.createElement('button');
                    applyAllBtn.textContent = '\ud83d\udcdd Apply Full Response to Editor';
                    applyAllBtn.addEventListener('click', () => {
                        vscode.postMessage({ type: 'applyCode', value: stripFences(currentAiRaw) });
                    });
                    const copyAllBtn = document.createElement('button');
                    copyAllBtn.textContent = '\ud83d\udccb Copy Full Response';
                    copyAllBtn.addEventListener('click', () => {
                        navigator.clipboard.writeText(stripFences(currentAiRaw));
                    });
                    footer.appendChild(applyAllBtn);
                    footer.appendChild(copyAllBtn);
                    currentAi.appendChild(footer);
                }
            }
        });
    </script>
</body>
</html>`;

        webviewView.webview.onDidReceiveMessage(async (data) => {
            if (data.type === 'sendPrompt') {
                this._streamFromOllama(data.value, webviewView.webview);
            } else if (data.type === 'grabText') {
                const ed = this.lastActiveEditor ?? vscode.window.activeTextEditor;
                if (ed) {
                    const fileName = ed.document.fileName.split(/[\\/]/).pop();
                    webviewView.webview.postMessage({ type: 'attach', label: `✨ ${fileName} (selection)`, value: ed.document.getText(ed.selection) });
                } else {
                    vscode.window.showWarningMessage('NRGBot: No editor found to grab text from.');
                }
            } else if (data.type === 'grabPage') {
                const ed = this.lastActiveEditor ?? vscode.window.activeTextEditor;
                console.log('[NRGBot] grabPage handler, editor:', ed?.document.fileName);
                if (ed) {
                    const fileName = ed.document.fileName.split(/[\\/]/).pop();
                    webviewView.webview.postMessage({ type: 'attach', label: `📄 ${fileName}`, value: ed.document.getText() });
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

    private _streamFromOllama(promptText: string, webview: vscode.Webview) {
        const config = vscode.workspace.getConfiguration('nrgbot');
        const configuredUrl = config.get<string>('serverUrl') || 'http://192.168.3.142:11434';
        const modelName = config.get<string>('modelName') || 'qwen2.5-coder:7b';
        
        let parsedUrl: URL;
        try {
            parsedUrl = new URL(configuredUrl);
        } catch (err) {
            parsedUrl = new URL('http://192.168.3.142:11434');
        }

        const postData = JSON.stringify({
            model: modelName,
            messages: [{ role: "user", content: promptText }],
            stream: true
        });

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 80,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Content-Length': Buffer.byteLength(postData) 
            }
        };

        const req = http.request(options, (res) => {
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
                        } catch (e) {}
                    }
                }
            });
            res.on('end', () => { webview.postMessage({ type: 'done' }); });
        });
        
        req.on('error', (e) => { 
            webview.postMessage({ type: 'error', value: e.message }); 
            vscode.window.showErrorMessage('NRGBot Connection Failure: ' + e.message);
        });
        
        req.write(postData);
        req.end();
    }
}
