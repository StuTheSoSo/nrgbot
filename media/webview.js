(function () {
    const vscode = acquireVsCodeApi();
    const chatBox = document.getElementById('chat-box');
    const promptInput = document.getElementById('prompt');
    const attachmentsEl = document.getElementById('attachments');
    const sendBtn = document.getElementById('send-btn');
    let currentAi = null;
    let currentAiRaw = '';
    let attachments = [];
    let conversation = [];
    let isStreaming = false;

    function setStreaming(active) {
        isStreaming = active;
        sendBtn.textContent = active ? '⏹ Stop' : 'Send to Remote Machine';
        sendBtn.classList.toggle('stop-mode', active);
    }

    function escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function renderMarkdown(md) {
        const codeBlocks = [];
        let text = md.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
            codeBlocks.push(
                '<div class="code-block"><div class="code-actions">' +
                '<button class="apply-btn">\uD83D\uDCDD Apply to Editor</button>' +
                '<button class="copy-btn">\uD83D\uDCCB Copy</button></div>' +
                '<pre><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre></div>'
            );
            return '\u0000' + (codeBlocks.length - 1) + '\u0000';
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
            if (/^<(h\d|ul|pre)/.test(block.trim()) || block.indexOf('\u0000') === 0) return block;
            return '<p>' + block.replace(/\n/g, '<br>') + '</p>';
        }).join('');

        text = text.replace(/\u0000(\d+)\u0000/g, (m, i) => codeBlocks[Number(i)]);
        return text;
    }

    function stripFences(raw) {
        const m = raw.trim().match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
        return m ? m[1] : raw;
    }

    function renderAttachments() {
        attachmentsEl.innerHTML = '';
        attachments.forEach((att, i) => {
            const chip = document.createElement('span');
            chip.style.cssText = 'background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);padding:2px 6px;border-radius:10px;font-size:0.85em;';
            chip.textContent = '\uD83D\uDCCC ' + att.label + ' \u2715';
            chip.title = 'Pinned to every message \u2014 click to detach';
            chip.style.cursor = 'pointer';
            chip.addEventListener('click', () => { attachments.splice(i, 1); renderAttachments(); });
            attachmentsEl.appendChild(chip);
        });
    }

    document.getElementById('send-btn').addEventListener('click', () => {
        if (isStreaming) {
            vscode.postMessage({ type: 'stopStream' });
            setStreaming(false);
            if (currentAi) {
                currentAi.classList.remove('pending');
                if (!currentAiRaw) {
                    currentAi.innerText = 'Stopped.';
                    conversation.pop();
                } else {
                    currentAi.innerHTML = renderMarkdown(currentAiRaw);
                }
            }
            return;
        }
        const text = promptInput.value.trim();
        if (!text && attachments.length === 0) return;
        chatBox.innerHTML += '<div class="msg user">' + escapeHtml(text) + '</div>';

        let fullPrompt = text;
        if (attachments.length) {
            fullPrompt += '\n\n' + attachments.map(a => '```\n' + a.value + '\n```').join('\n\n');
        }

        promptInput.value = '';
        currentAi = document.createElement('div');
        currentAi.className = 'msg ai pending';
        currentAiRaw = '';
        currentAi.innerText = 'Thinking...';
        chatBox.appendChild(currentAi);
        chatBox.scrollTop = chatBox.scrollHeight;
        conversation.push({ role: 'user', content: fullPrompt });
        setStreaming(true);
        vscode.postMessage({ type: 'sendPrompt', value: conversation });
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
        chatBox.innerHTML = '';
        promptInput.value = '';
        renderAttachments();
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
        if (msg.type === 'token') {
            currentAiRaw += msg.value;
            currentAi.classList.remove('pending');
            currentAi.innerHTML = renderMarkdown(currentAiRaw);
            chatBox.scrollTop = chatBox.scrollHeight;
        } else if (msg.type === 'attach') {
            attachments.push({ label: msg.label, value: msg.value });
            renderAttachments();
        } else if (msg.type === 'error') {
            currentAi.classList.remove('pending');
            currentAi.innerText = 'Error: ' + msg.value;
            conversation.pop();
            setStreaming(false);
        } else if (msg.type === 'done') {
            setStreaming(false);
            if (currentAi && currentAiRaw) {
                conversation.push({ role: 'assistant', content: currentAiRaw });
                const footer = document.createElement('div');
                footer.className = 'code-actions';
                footer.style.marginTop = '6px';
                const applyAllBtn = document.createElement('button');
                applyAllBtn.textContent = '\uD83D\uDCDD Apply Full Response to Editor';
                applyAllBtn.addEventListener('click', () => {
                    vscode.postMessage({ type: 'applyCode', value: stripFences(currentAiRaw) });
                });
                const copyAllBtn = document.createElement('button');
                copyAllBtn.textContent = '\uD83D\uDCCB Copy Full Response';
                copyAllBtn.addEventListener('click', () => {
                    navigator.clipboard.writeText(stripFences(currentAiRaw));
                });
                footer.appendChild(applyAllBtn);
                footer.appendChild(copyAllBtn);
                currentAi.appendChild(footer);
            }
        }
    });
})();
