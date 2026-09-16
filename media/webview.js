(function () {
    const vscode = acquireVsCodeApi();
    const chatBox = document.getElementById('chat-box');
    const promptInput = document.getElementById('prompt');
    const attachmentsEl = document.getElementById('attachments');
    const sendBtn = document.getElementById('send-btn');
    const settingsBtn = document.getElementById('settings-btn');
    const settingsPanel = document.getElementById('settings-panel');
    const serverUrlInput = document.getElementById('server-url');
    const modelSelect = document.getElementById('model-select');
    const connectBtn = document.getElementById('connect-btn');
    const refreshModelsBtn = document.getElementById('refresh-models-btn');
    const settingsStatus = document.getElementById('settings-status');
    let currentAi = null;
    let currentAiContent = null;
    let currentToolLog = null;
    let currentAiRaw = '';
    let attachments = [];
    let conversation = [];
    let isStreaming = false;

    function setStreaming(active) {
        isStreaming = active;
        sendBtn.innerHTML = active
            ? '<i class="codicon codicon-debug-stop"></i> Stop'
            : '<i class="codicon codicon-send"></i> Send';
        sendBtn.classList.toggle('stop-mode', active);
    }

    function escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function splitTableRow(line) {
        let l = line.trim();
        if (l.startsWith('|')) l = l.slice(1);
        if (l.endsWith('|')) l = l.slice(0, -1);
        return l.split('|').map(c => c.trim());
    }

    function convertTables(text) {
        const lines = text.split('\n');
        const out = [];
        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            const sep = lines[i + 1];
            const isSeparator = sep !== undefined && /\|/.test(sep) && /^[\s|:-]+$/.test(sep) && /-/.test(sep);
            if (/\|/.test(line) && line.trim() !== '' && isSeparator) {
                const headers = splitTableRow(line);
                const rows = [];
                let j = i + 2;
                while (j < lines.length && /\|/.test(lines[j]) && lines[j].trim() !== '') {
                    rows.push(splitTableRow(lines[j]));
                    j++;
                }
                let html = '<table class="md-table"><thead><tr>';
                headers.forEach(h => { html += '<th>' + escapeHtml(h) + '</th>'; });
                html += '</tr></thead><tbody>';
                rows.forEach(r => {
                    html += '<tr>';
                    headers.forEach((_, idx) => { html += '<td>' + escapeHtml(r[idx] !== undefined ? r[idx] : '') + '</td>'; });
                    html += '</tr>';
                });
                html += '</tbody></table>';
                out.push(html);
                i = j;
            } else {
                out.push(line);
                i++;
            }
        }
        return out.join('\n');
    }

    function renderMarkdown(md) {
        const codeBlocks = [];
        let text = md.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
            codeBlocks.push(
                '<div class="code-block"><div class="code-head">' +
                '<span class="code-lang">' + escapeHtml(lang || 'code') + '</span>' +
                '<span class="code-head-actions">' +
                '<button class="icon-btn apply-btn" title="Apply to editor"><i class="codicon codicon-diff"></i></button>' +
                '<button class="icon-btn copy-btn" title="Copy"><i class="codicon codicon-copy"></i></button>' +
                '</span></div>' +
                '<pre><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre></div>'
            );
            return '\u0000' + (codeBlocks.length - 1) + '\u0000';
        });

        const tableBlocks = [];
        text = convertTables(text).replace(/<table class="md-table">[\s\S]*?<\/table>/g, (m) => {
            tableBlocks.push(m);
            return '\u0001' + (tableBlocks.length - 1) + '\u0001';
        });

        text = escapeHtml(text);
        text = text.replace(/^### (.*)$/gm, '<h3>$1</h3>');
        text = text.replace(/^## (.*)$/gm, '<h2>$1</h2>');
        text = text.replace(/^# (.*)$/gm, '<h1>$1</h1>');
        text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
        text = text.replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>');
        text = text.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, (m) => '<ul>' + m + '</ul>');
        text = text.split(/\n{2,}/).map(block => {
            if (/^<(h\d|ul|pre)/.test(block.trim()) || block.indexOf('\u0000') === 0 || block.indexOf('\u0001') === 0) return block;
            return '<p>' + block.replace(/\n/g, '<br>') + '</p>';
        }).join('');

        text = text.replace(/\u0000(\d+)\u0000/g, (m, i) => codeBlocks[Number(i)]);
        text = text.replace(/\u0001(\d+)\u0001/g, (m, i) => tableBlocks[Number(i)]);
        return text;
    }

    // stripFences and getCodeBlocks mirror src/parsing.ts (kept in sync manually; tested there).
    function stripFences(raw) {
        const lines = raw.trim().split('\n');
        if (!/^```[a-zA-Z0-9]*\s*$/.test(lines[0])) return raw.trim();
        lines.shift();
        // Drop trailing blank lines and any (possibly duplicated) closing fence lines.
        while (lines.length) {
            const last = lines[lines.length - 1].trim();
            if (last === '' || last === '```') {
                lines.pop();
                continue;
            }
            break;
        }
        return lines.join('\n').trimEnd();
    }

    function getCodeBlocks(raw) {
        const blocks = [];
        raw.replace(/```[^\n]*\n([\s\S]*?)```/g, (match, code) => {
            blocks.push(code.replace(/\n$/, ''));
            return match;
        });
        return blocks;
    }

    function renderAttachments() {
        attachmentsEl.innerHTML = '';
        attachments.forEach((att, i) => {
            const chip = document.createElement('span');
            chip.className = 'chip';
            chip.title = att.label;
            const icon = document.createElement('i');
            icon.className = 'codicon codicon-file chip-icon';
            const name = document.createElement('span');
            name.className = 'chip-name';
            name.textContent = att.label;
            const close = document.createElement('span');
            close.className = 'chip-close';
            close.title = 'Detach';
            close.innerHTML = '<i class="codicon codicon-close"></i>';
            close.addEventListener('click', () => { attachments.splice(i, 1); renderAttachments(); saveState(); });
            chip.appendChild(icon);
            chip.appendChild(name);
            chip.appendChild(close);
            attachmentsEl.appendChild(chip);
        });
    }

    // Persist the thread across window reloads (webview state is backed by VS Code storage).
    function saveState() {
        vscode.setState({ conversation, attachments });
    }

    function avatarHtml(role) {
        const icon = role === 'ai' ? 'codicon-zap' : 'codicon-account';
        return '<span class="msg-avatar"><i class="codicon ' + icon + '"></i></span>';
    }

    function typingHtml() {
        return '<div class="typing"><span></span><span></span><span></span></div>';
    }

    function createUserRow(text) {
        const row = document.createElement('div');
        row.className = 'msg user';
        row.innerHTML = avatarHtml('user') +
            '<div class="msg-body"><div class="msg-author">You</div><div class="msg-content"></div></div>';
        row.querySelector('.msg-content').textContent = text;
        return row;
    }

    function createAiRow() {
        const row = document.createElement('div');
        row.className = 'msg ai pending';
        row.innerHTML = avatarHtml('ai') +
            '<div class="msg-body"><div class="msg-author">NRGBot</div>' +
            '<div class="tool-log"></div><div class="msg-content"></div></div>';
        return {
            row: row,
            body: row.querySelector('.msg-body'),
            content: row.querySelector('.msg-content'),
            toolLog: row.querySelector('.tool-log')
        };
    }

    function buildAssistantFooter(raw) {
        const footer = document.createElement('div');
        footer.className = 'msg-footer';
        const codeBlocks = getCodeBlocks(raw);
        if (codeBlocks.length === 1) {
            const applyBtn = document.createElement('button');
            applyBtn.className = 'btn';
            applyBtn.innerHTML = '<i class="codicon codicon-diff"></i> Apply';
            applyBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'applyCode', value: codeBlocks[0] });
            });
            footer.appendChild(applyBtn);
        }
        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn';
        copyBtn.innerHTML = '<i class="codicon codicon-copy"></i> Copy';
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(raw);
        });
        footer.appendChild(copyBtn);
        return footer;
    }

    function renderEmptyState() {
        const w = document.createElement('div');
        w.className = 'welcome';
        w.innerHTML =
            '<div class="welcome-mark"><i class="codicon codicon-zap"></i></div>' +
            '<h2>NRG<b>Bot</b></h2>' +
            '<p>Your private code wizard, powered by remote Ollama.</p>' +
            '<div class="welcome-hints">' +
            '<div class="welcome-hint"><i class="codicon codicon-list-selection"></i><span>Attach a selection or full file as context</span></div>' +
            '<div class="welcome-hint"><i class="codicon codicon-comment-discussion"></i><span>Ask questions or request code changes</span></div>' +
            '<div class="welcome-hint"><i class="codicon codicon-diff"></i><span>Preview edits as a diff before applying</span></div>' +
            '</div>';
        chatBox.appendChild(w);
    }

    function removeWelcome() {
        const w = chatBox.querySelector('.welcome');
        if (w) w.remove();
    }

    function renderConversation() {
        chatBox.innerHTML = '';
        if (!conversation.length) {
            renderEmptyState();
            return;
        }
        conversation.forEach(m => {
            if (m.role === 'user') {
                chatBox.appendChild(createUserRow(m.display != null ? m.display : m.content));
            } else if (m.role === 'assistant') {
                const ai = createAiRow();
                ai.row.classList.remove('pending');
                ai.content.innerHTML = renderMarkdown(m.content);
                ai.body.appendChild(buildAssistantFooter(m.content));
                chatBox.appendChild(ai.row);
            }
        });
        chatBox.scrollTop = chatBox.scrollHeight;
    }

    document.getElementById('send-btn').addEventListener('click', () => {
        if (isStreaming) {
            vscode.postMessage({ type: 'stopStream' });
            setStreaming(false);
            if (currentAi) {
                currentAi.classList.remove('pending');
                if (!currentAiRaw) {
                    currentAiContent.innerText = 'Stopped.';
                    conversation.pop();
                } else {
                    currentAiContent.innerHTML = renderMarkdown(currentAiRaw);
                    conversation.push({ role: 'assistant', content: currentAiRaw });
                }
            }
            saveState();
            return;
        }
        const text = promptInput.value.trim();
        if (!text && attachments.length === 0) return;
        removeWelcome();
        chatBox.appendChild(createUserRow(text));

        let fullPrompt = text;
        if (attachments.length) {
            fullPrompt += '\n\n' + attachments.map(a => 'Attached file: ' + (a.fileName || a.label) + '\n```\n' + a.value + '\n```').join('\n\n');
        }

        promptInput.value = '';
        const ai = createAiRow();
        currentAi = ai.row;
        currentAiContent = ai.content;
        currentToolLog = ai.toolLog;
        currentAiRaw = '';
        currentAiContent.innerHTML = typingHtml();
        chatBox.appendChild(currentAi);
        chatBox.scrollTop = chatBox.scrollHeight;
        conversation.push({ role: 'user', content: fullPrompt, display: text });
        saveState();
        setStreaming(true);
        vscode.postMessage({ type: 'sendPrompt', value: conversation.map(m => ({ role: m.role, content: m.content })) });
    });

    promptInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            document.getElementById('send-btn').click();
        }
    });

    document.getElementById('clear-btn').addEventListener('click', () => {
        if (isStreaming) {
            vscode.postMessage({ type: 'stopStream' });
            setStreaming(false);
        }
        conversation = [];
        attachments = [];
        currentAi = null;
        currentAiRaw = '';
        promptInput.value = '';
        renderConversation();
        renderAttachments();
        saveState();
    });

    document.getElementById('grab-btn').addEventListener('click', () => {
        attachmentsEl.textContent = 'Grabbing selection...';
        vscode.postMessage({ type: 'grabText' });
    });
    document.getElementById('page-btn').addEventListener('click', () => {
        attachmentsEl.textContent = 'Grabbing full page...';
        vscode.postMessage({ type: 'grabPage' });
    });

    settingsBtn.addEventListener('click', () => {
        const showing = settingsPanel.style.display !== 'none';
        settingsPanel.style.display = showing ? 'none' : 'block';
        if (!showing) vscode.postMessage({ type: 'getModels' });
    });
    connectBtn.addEventListener('click', () => {
        const url = serverUrlInput.value.trim();
        if (!url) return;
        settingsStatus.className = 'settings-status';
        settingsStatus.textContent = 'Connecting...';
        vscode.postMessage({ type: 'setServerUrl', value: url });
    });
    refreshModelsBtn.addEventListener('click', () => {
        settingsStatus.className = 'settings-status';
        settingsStatus.textContent = 'Loading models...';
        vscode.postMessage({ type: 'getModels' });
    });
    modelSelect.addEventListener('change', () => {
        if (!modelSelect.value) return;
        vscode.postMessage({ type: 'setModel', value: modelSelect.value });
        settingsStatus.className = 'settings-status';
        settingsStatus.textContent = 'Model set to ' + modelSelect.value;
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
        if (msg.type === 'token') {
            currentAiRaw += msg.value;
            currentAi.classList.remove('pending');
            currentAiContent.innerHTML = renderMarkdown(currentAiRaw);
            chatBox.scrollTop = chatBox.scrollHeight;
        } else if (msg.type === 'toolCall') {
            currentAi.classList.remove('pending');
            const note = document.createElement('div');
            note.className = 'tool-note';
            note.innerHTML = '<i class="codicon codicon-tools"></i>';
            const label = document.createElement('span');
            label.textContent = msg.name + '(' + (msg.args || '') + ')';
            note.appendChild(label);
            currentToolLog.appendChild(note);
            chatBox.scrollTop = chatBox.scrollHeight;
        } else if (msg.type === 'attach') {
            attachments.push({ label: msg.label, fileName: msg.fileName, value: msg.value });
            renderAttachments();
            saveState();
        } else if (msg.type === 'error') {
            if (currentAi) currentAi.classList.remove('pending');
            if (currentAiContent) currentAiContent.innerText = 'Error: ' + msg.value;
            conversation.pop();
            setStreaming(false);
            saveState();
        } else if (msg.type === 'streamError') {
            // Mid-stream drop: keep whatever streamed so far and show a failed indicator.
            if (currentAi) {
                currentAi.classList.remove('pending');
                if (currentAiRaw) {
                    currentAiContent.innerHTML = renderMarkdown(currentAiRaw);
                    conversation.push({ role: 'assistant', content: currentAiRaw });
                } else {
                    if (currentAiContent) currentAiContent.innerHTML = '';
                    conversation.pop();
                }
                const note = document.createElement('div');
                note.className = 'stream-status failed';
                note.innerHTML = '<i class="codicon codicon-warning"></i>';
                const span = document.createElement('span');
                span.textContent = msg.value || 'Connection lost before the response finished.';
                note.appendChild(span);
                (currentAi.querySelector('.msg-body') || currentAi).appendChild(note);
            }
            setStreaming(false);
            saveState();
        } else if (msg.type === 'done') {
            setStreaming(false);
            if (currentAi && currentAiRaw) {
                conversation.push({ role: 'assistant', content: currentAiRaw });
                (currentAi.querySelector('.msg-body') || currentAi).appendChild(buildAssistantFooter(currentAiRaw));
            } else if (currentAi && !currentAiRaw && currentAiContent) {
                currentAiContent.innerHTML = '';
            }
            saveState();
        } else if (msg.type === 'models') {
            if (typeof msg.serverUrl === 'string' && document.activeElement !== serverUrlInput) {
                serverUrlInput.value = msg.serverUrl;
            }
            const models = Array.isArray(msg.models) ? msg.models : [];
            modelSelect.innerHTML = '';
            const names = models.slice();
            // Always include the configured model so the current selection is visible even if the fetch failed.
            if (msg.current && names.indexOf(msg.current) === -1) names.unshift(msg.current);
            names.forEach(name => {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                if (name === msg.current) opt.selected = true;
                modelSelect.appendChild(opt);
            });
            if (msg.error) {
                settingsStatus.className = 'settings-status error';
                settingsStatus.innerHTML = '<i class="codicon codicon-warning"></i>';
                const s = document.createElement('span');
                s.textContent = msg.error;
                settingsStatus.appendChild(s);
            } else {
                settingsStatus.className = 'settings-status';
                settingsStatus.innerHTML = '<i class="codicon codicon-check"></i>';
                const s = document.createElement('span');
                s.textContent = models.length
                    ? models.length + ' model' + (models.length === 1 ? '' : 's') + ' available'
                    : 'No models found on the server.';
                settingsStatus.appendChild(s);
            }
        }
    });

    // Restore any persisted thread (or show the welcome state), then load models.
    const savedState = vscode.getState();
    conversation = savedState && Array.isArray(savedState.conversation) ? savedState.conversation : [];
    attachments = savedState && Array.isArray(savedState.attachments) ? savedState.attachments : [];
    renderConversation();
    renderAttachments();
    vscode.postMessage({ type: 'getModels' });
})();
