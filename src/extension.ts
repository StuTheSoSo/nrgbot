import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { TOOLS, executeTool, isKnownTool } from './tools';
import { extractLeadingToolCallJson, findToolCallJson, takeCompleteLines } from './parsing';
import { determineRequestRouting } from './requestRouting';
import { buildBaselineContextMessage, composeRequestMessages } from './messageComposition';
import { budgetProjectContext, RULES_CONTEXT_PREFIX } from './contextBudget';
import {
    ATTACHMENT_SYSTEM_PROMPT,
    FILE_ACTION_SYSTEM_PROMPT,
    GROUNDING_PREAMBLE,
    missingAccessReminder,
    POST_TOOL_SYSTEM_PROMPT
} from './grounding';
import {
    DEFAULT_KNOWLEDGE_FILE,
    DEFAULT_RULES_FILE,
    DEFAULT_CONTEXT_MAX_CHARS,
    KNOWLEDGE_DOC_TEMPLATE,
    REFACTOR_RULES_TEMPLATE,
    readKnowledgeDoc,
    generateProjectMap
} from './projectContext';

interface ProjectContext {
    knowledge: string;
    map: string;
    rules: string;
}

export function activate(context: vscode.ExtensionContext) {
    const previewProvider = new ApplyPreviewProvider();
    const provider = new OllamaViewProvider(context.extensionUri, previewProvider);

    const projectWatcher = vscode.workspace.createFileSystemWatcher('**/*.{sln,csproj,vcxproj}');
    const invalidate = () => provider.invalidateProjectContext();
    projectWatcher.onDidCreate(invalidate);
    projectWatcher.onDidChange(invalidate);
    projectWatcher.onDidDelete(invalidate);

    // The knowledge and rules doc paths are configurable, so their watchers are rebuilt when a
    // setting changes.
    let docWatchers: vscode.FileSystemWatcher[] = [];
    const rebuildDocWatchers = () => {
        docWatchers.forEach(w => w.dispose());
        docWatchers = [];
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return;
        const cfg = vscode.workspace.getConfiguration('nrgbot');
        const files = [
            cfg.get<string>('knowledgeFile') || DEFAULT_KNOWLEDGE_FILE,
            cfg.get<string>('refactorRulesFile') || DEFAULT_RULES_FILE
        ];
        for (const file of files) {
            const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folders[0], file));
            w.onDidCreate(invalidate);
            w.onDidChange(invalidate);
            w.onDidDelete(invalidate);
            docWatchers.push(w);
        }
    };
    rebuildDocWatchers();

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(ApplyPreviewProvider.scheme, previewProvider),
        vscode.window.registerWebviewViewProvider('ollama.chatSidebarView', provider),
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) provider.lastActiveEditor = editor;
        }),
        vscode.window.tabGroups.onDidChangeTabs(() => provider.syncPendingEditWithOpenTabs()),
        projectWatcher,
        { dispose: () => docWatchers.forEach(w => w.dispose()) },
        vscode.workspace.onDidChangeConfiguration(e => {
            if (!e.affectsConfiguration('nrgbot')) return;
            invalidate();
            if (e.affectsConfiguration('nrgbot.knowledgeFile') || e.affectsConfiguration('nrgbot.refactorRulesFile')) rebuildDocWatchers();
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            invalidate();
            rebuildDocWatchers();
        }),
        vscode.commands.registerCommand('nrgbot.refreshProjectContext', async () => {
            provider.invalidateProjectContext();
            const ctx = await provider.warmProjectContext();
            vscode.window.showInformationMessage(`NRGBot: context refreshed \u2014 knowledge ${ctx.knowledge.length} chars, map ${ctx.map.length} chars, rules ${ctx.rules.length} chars.`);
        }),
        vscode.commands.registerCommand('nrgbot.applyProposedEdit', () => provider.applyProposedEdit()),
        vscode.commands.registerCommand('nrgbot.discardProposedEdit', () => provider.discardProposedEdit()),
        vscode.commands.registerCommand('nrgbot.attachSelection', () => provider.attachSelectionToChat()),
        vscode.commands.registerCommand('nrgbot.attachFile', () => provider.attachFileToChat()),
        vscode.commands.registerCommand('nrgbot.askAboutSelection', () => provider.askAboutSelection()),
        vscode.commands.registerCommand('nrgbot.generateKnowledgeDoc', async () => {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders || folders.length === 0) {
                vscode.window.showWarningMessage('NRGBot: open a workspace folder first.');
                return;
            }
            const file = vscode.workspace.getConfiguration('nrgbot').get<string>('knowledgeFile') || DEFAULT_KNOWLEDGE_FILE;
            const uri = vscode.Uri.joinPath(folders[0].uri, file);
            let existed = true;
            try {
                await vscode.workspace.fs.stat(uri);
            } catch {
                existed = false;
                await vscode.workspace.fs.writeFile(uri, Buffer.from(KNOWLEDGE_DOC_TEMPLATE, 'utf8'));
                provider.invalidateProjectContext();
            }
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
            if (existed) {
                vscode.window.showInformationMessage(`NRGBot: ${file} already exists; opened it.`);
            }
        }),
        vscode.commands.registerCommand('nrgbot.generateRefactorRules', async () => {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders || folders.length === 0) {
                vscode.window.showWarningMessage('NRGBot: open a workspace folder first.');
                return;
            }
            const file = vscode.workspace.getConfiguration('nrgbot').get<string>('refactorRulesFile') || DEFAULT_RULES_FILE;
            const uri = vscode.Uri.joinPath(folders[0].uri, file);
            let existed = true;
            try {
                await vscode.workspace.fs.stat(uri);
            } catch {
                existed = false;
                await vscode.workspace.fs.writeFile(uri, Buffer.from(REFACTOR_RULES_TEMPLATE, 'utf8'));
                provider.invalidateProjectContext();
            }
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
            if (existed) {
                vscode.window.showInformationMessage(`NRGBot: ${file} already exists; opened it.`);
            }
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
    private static readonly CHAT_REQUEST_TIMEOUT_MS = 120000;

    public lastActiveEditor: vscode.TextEditor | undefined;
    private _view: vscode.WebviewView | undefined;
    private activeRequest: http.ClientRequest | undefined;
    private streamAborted = false;
    private projectContext: ProjectContext | undefined;
    private pendingEdit: { edit: vscode.WorkspaceEdit; previewUri: vscode.Uri } | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly previewProvider: ApplyPreviewProvider
    ) {}

    /** Apply the change currently shown in the proposed-diff preview (title-bar Apply button). */
    public async applyProposedEdit(): Promise<void> {
        const pending = this.pendingEdit;
        if (!pending) return;
        await vscode.workspace.applyEdit(pending.edit);
        await this.clearPendingEdit();
    }

    /** Discard the proposed change without applying it (title-bar Discard button). */
    public async discardProposedEdit(): Promise<void> {
        if (!this.pendingEdit) return;
        await this.clearPendingEdit();
    }

    private async clearPendingEdit(): Promise<void> {
        const pending = this.pendingEdit;
        this.pendingEdit = undefined;
        await vscode.commands.executeCommand('setContext', 'nrgbot.hasPendingEdit', false);
        if (!pending) return;
        // Close the proposed-diff tab so the accept/deny affordance disappears once resolved.
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const input = tab.input as vscode.TabInputTextDiff | undefined;
                if (input?.modified?.toString() === pending.previewUri.toString()) {
                    await vscode.window.tabGroups.close(tab);
                }
            }
        }
    }

    /** If the proposed-diff tab was closed without Apply/Discard, disarm the buttons. */
    public async syncPendingEditWithOpenTabs(): Promise<void> {
        const pending = this.pendingEdit;
        if (!pending) return;
        const stillOpen = vscode.window.tabGroups.all.some(group =>
            group.tabs.some(tab => {
                const input = tab.input as vscode.TabInputTextDiff | undefined;
                return input?.modified?.toString() === pending.previewUri.toString();
            }));
        if (!stillOpen) {
            this.pendingEdit = undefined;
            await vscode.commands.executeCommand('setContext', 'nrgbot.hasPendingEdit', false);
        }
    }

    /** Attach the editor selection to the chat (right-click "Add Selection to Chat"). */
    public attachSelectionToChat(): Promise<void> {
        return this._attachFromEditor('selection', false);
    }

    /** Attach the whole active file to the chat (right-click "Add File to Chat"). */
    public attachFileToChat(): Promise<void> {
        return this._attachFromEditor('file', false);
    }

    /** Attach the selection and focus the prompt so the user can type a question. */
    public askAboutSelection(): Promise<void> {
        return this._attachFromEditor('selection', true);
    }

    private async _attachFromEditor(scope: 'selection' | 'file', focusPrompt: boolean): Promise<void> {
        const ed = this.lastActiveEditor ?? vscode.window.activeTextEditor;
        if (!ed) {
            vscode.window.showWarningMessage('NRGBot: No editor found.');
            return;
        }
        if (scope === 'selection' && ed.selection.isEmpty) {
            vscode.window.showWarningMessage('NRGBot: Select some code first.');
            return;
        }
        const fileName = vscode.workspace.asRelativePath(ed.document.uri);
        const raw = scope === 'selection' ? ed.document.getText(ed.selection) : ed.document.getText();
        const content = await this._confirmAttachmentSize(raw, scope === 'selection' ? 'Selection' : 'Full page');
        if (content === undefined) return;
        await this._revealChat(!focusPrompt);
        const label = scope === 'selection' ? `\u2728 ${fileName} (selection)` : `\uD83D\uDCC4 ${fileName}`;
        this._view?.webview.postMessage({ type: 'attach', label, fileName, value: content });
        if (focusPrompt) this._view?.webview.postMessage({ type: 'focusPrompt' });
    }

    /** Reveal the chat view so a command that feeds it has somewhere to land. */
    private async _revealChat(preserveFocus: boolean): Promise<void> {
        if (this._view) {
            this._view.show?.(preserveFocus);
        } else {
            await vscode.commands.executeCommand('ollama.chatSidebarView.focus');
        }
    }

    /** Drop the cached project context so the next request regenerates it. */
    public invalidateProjectContext(): void {
        this.projectContext = undefined;
    }

    /** Eagerly (re)build the cached project context, e.g. from the refresh command. */
    public async warmProjectContext(): Promise<ProjectContext> {
        return this.getProjectContext();
    }

    private async getProjectContext(): Promise<ProjectContext> {
        if (this.projectContext) return this.projectContext;
        const config = vscode.workspace.getConfiguration('nrgbot');
        const knowledgeFile = config.get<string>('knowledgeFile') || DEFAULT_KNOWLEDGE_FILE;
        const rulesFile = config.get<string>('refactorRulesFile') || DEFAULT_RULES_FILE;
        const includeMap = config.get<boolean>('includeProjectMap') !== false;
        const knowledge = await readKnowledgeDoc(knowledgeFile, 0);
        const rules = await readKnowledgeDoc(rulesFile, 0);
        const map = includeMap ? await generateProjectMap(0) : '';
        console.log(`[NRGBot] project context loaded: knowledge=${knowledge.length} chars from "${knowledgeFile}", map=${map.length} chars, rules=${rules.length} chars from "${rulesFile}"`);
        this.projectContext = { knowledge, map, rules };
        return this.projectContext;
    }

    private static readonly BASE_SYSTEM_PROMPT = 'You are a coding assistant inside VS Code. The user\'s message may already include attached file content in fenced code blocks, each preceded by a line like "Attached file: <name>". That attached content IS the file the user is referring to; treat it as fully available and answer from it directly. Never call read_file or list_directory for a file whose content is already attached, and never claim an attached file does not exist. Do not echo or quote the complete attached file unless the user explicitly asks for it. You have read-only tools (read_file, list_directory, search_text, list_files) that give you direct access to every file in the workspace. When a question needs file contents, sizes, line counts, or the largest files, CALL THE TOOLS to gather the facts instead of asking the user to attach files or emitting placeholder values. Use list_files (with sortBy and limit) for questions about file sizes, line counts, or largest files. Never guess or fabricate file data. Never write JSON tool calls in your response. Only call tools supplied in this request; never invent a tool such as analyze_code_quality. Analyze attached code directly in your normal response. After a tool returns its result, write your final answer as plain English markdown prose. Never output JSON, JSON-RPC, an "error"/"result"/"jsonrpc" object, or any protocol message as your answer; the tool result is the real file content, so use it to answer the question.';

    // Attached file PLUS a question that needs other files (usages, references, callers): tools stay on.
    private static readonly ATTACHMENT_WITH_TOOLS_SYSTEM_PROMPT = 'You are a coding assistant inside VS Code. The user\'s message includes attached file content in fenced code blocks, each preceded by a line like "Attached file: <name>"; treat that attached content as fully available. The user\'s question needs information from OTHER files in the workspace (for example, where a symbol is used or referenced). Use the read-only tools to find it: search_text to find where a name appears across the workspace, list_files to locate files, and read_file to inspect another file. Call one tool at a time and wait for its result before the next. After the tools return, write your final answer as plain English markdown prose that cites the files and lines you found. Never ask the user to attach or paste files, never say you lack workspace access, and never output JSON, a bare tool call, or any protocol message as your final answer.';

    // The user asked to examine/read real files. A big grounding prompt suppresses tool-calling in a
    // 14b model, so this lean, tool-forward prompt is used instead to force an actual tool call.
    // Once tool results are in the conversation the model must stop calling tools and answer ONCE;
    // re-sending the tool-forward prompt here is what made it call again / answer twice.
    private buildSystemPrompt(
        context: ProjectContext,
        opts: { hasAttachment?: boolean; offerTools?: boolean; fileAction?: boolean; hasToolResults?: boolean } = {}
    ): string {
        if (opts.hasAttachment) {
            const base = opts.offerTools
                ? OllamaViewProvider.ATTACHMENT_WITH_TOOLS_SYSTEM_PROMPT
                : ATTACHMENT_SYSTEM_PROMPT;
            return this._appendRules(base, context.rules);
        }
        // Tool results already gathered: instruct a single final answer so the model stops re-calling.
        if (opts.hasToolResults) {
            return POST_TOOL_SYSTEM_PROMPT;
        }
        // An explicit "look at the files" request needs a lean prompt so tool-calling isn't drowned.
        if (opts.fileAction) {
            return FILE_ACTION_SYSTEM_PROMPT;
        }
        // Knowledge/map are delivered near the current question (see buildBaselineContextMessage), which a
        // small model attends to far better than a long system prompt, so the system message stays lean.
        const parts: string[] = [];
        if (context.knowledge || context.map) {
            parts.push(GROUNDING_PREAMBLE);
        }
        parts.push(OllamaViewProvider.BASE_SYSTEM_PROMPT);
        return parts.join('\n\n');
    }

    // Append the workspace refactoring rules so every attached-file coding request must follow them.
    private _appendRules(prompt: string, rules: string): string {
        if (!rules) return prompt;
        return `${prompt}${RULES_CONTEXT_PREFIX}${rules}`;
    }

    // A question about usages/references/callers needs other files, so keep tools on even with an
    // attachment. Only the user's typed text is checked (not the pasted file body) to avoid matching
    // words that merely appear in the attached code.
    private _questionNeedsWorkspaceLookup(
        messages: { role: string; content: string | null }[]
    ): boolean {
        const lastUser = [...messages].reverse().find(m => m.role === 'user' && typeof m.content === 'string');
        const raw = lastUser?.content;
        if (typeof raw !== 'string') return false;
        const marker = raw.indexOf('Attached file:');
        const question = marker >= 0 ? raw.slice(0, marker) : raw;
        return /\bwhere\b[^?]*\b(used|called|referenced|defined|declared|implemented)\b/i.test(question)
            || /\b(usages?|references?|referenced|callers?|call sites?|invoked|invocations?)\b/i.test(question)
            || /\bwho\s+(calls|uses|references)\b/i.test(question)
            || /\b(across|throughout|elsewhere|other files|entire\s+(project|codebase|solution|workspace|repo))\b/i.test(question)
            || /\bfind\b[^?]*\b(project|codebase|solution|workspace|repo)\b/i.test(question);
    }

    // An action request to inspect real files ("examine the files", "open X", "read Y", "list the
    // projects"). Used to swap in the lean tool-forward prompt so the model actually calls a tool.
    private _questionIsFileAction(
        messages: { role: string; content: string | null }[]
    ): boolean {
        const lastUser = [...messages].reverse().find(m => m.role === 'user' && typeof m.content === 'string');
        const raw = lastUser?.content;
        if (typeof raw !== 'string' || raw.includes('Attached file:')) return false;
        return /\b(examine|inspect|look at|read|open|show|browse|review|analyze|analyse|check|list|explore|scan|dig into|go through)\b[^.?!]{0,40}\b(file|files|code|contents?|directory|directories|folder|folders|project|projects|solution|class|classes|method|methods|source)\b/i.test(raw)
            || /\b(list|show)\b[^.?!]{0,20}\b(files?|projects?|directories|folders?)\b/i.test(raw)
            || /\b(largest|biggest|smallest)\b[^.?!]{0,20}\b(files?|projects?)\b/i.test(raw);
    }

    /** Load the webview markup from media/webview.html, substituting the runtime URIs. */
    private async _getHtmlForWebview(webview: vscode.Webview): Promise<string> {
        const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.js'));
        const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'codicon.css'));
        const template = Buffer.from(
            await vscode.workspace.fs.readFile(vscode.Uri.joinPath(mediaRoot, 'webview.html'))
        ).toString('utf8');
        return template
            .replace(/{{cspSource}}/g, webview.cspSource)
            .replace(/{{codiconUri}}/g, codiconUri.toString())
            .replace(/{{scriptUri}}/g, scriptUri.toString());
    }

    public async resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
        try {
            webviewView.webview.html = await this._getHtmlForWebview(webviewView.webview);
        } catch (err) {
            webviewView.webview.html = `<!DOCTYPE html><body style="font-family:sans-serif;padding:12px">Failed to load NRGBot UI: ${String(err)}</body>`;
        }

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
            `${fileName} \u2194 Proposed (${choice})  \u2013 use \u2713 Apply / \u2715 Discard in the title bar`,
            { preview: true }
        );

        // Arm the title-bar Apply/Discard buttons (see contributes.menus). Replaces an easy-to-miss
        // corner toast so accepting or rejecting the change is unmistakable in the diff itself.
        this.pendingEdit = { edit, previewUri };
        await vscode.commands.executeCommand('setContext', 'nrgbot.hasPendingEdit', true);
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

    /** Tells that the model guessed at file data instead of calling a tool to fetch it. */
    private _looksLikeMissingFileAccess(text: string): boolean {
        if (!text) return false;
        return /\b(hypothetical|placeholder|rough estimate)\b/i.test(text)
            || /(attach|provide|share|paste)\w*\b[^.]{0,50}\b(file|files|code|contents?)\b/i.test(text)
            || /\bI (do not|don'?t) have (direct )?(access|visibility)\b/i.test(text)
            || /\bwithout (access to|seeing|the actual)\b/i.test(text)
            || /\b(can'?t|cannot|can not|unable to|not able to|no ability to|don'?t have the (ability|capability)|not capable of)\b[^.]{0,60}\b(access|open|read|browse|view|see|interact|analyz|inspect)\w*/i.test(text)
            || /\bas an?\s+(ai|language|text[- ]based)\s+(model|assistant)\b/i.test(text);
    }

    // Weak models sometimes reply with a bare JSON blob (an echoed call, a fake {"error":...} or
    // a hallucinated jsonrpc envelope) instead of a real answer. Detect "the whole message is JSON".
    private _looksLikeBareJsonAnswer(text: string): boolean {
        if (!text) return false;
        let s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        if (!s.startsWith('{') && !s.startsWith('[')) return false;
        const open = s[0];
        const close = open === '{' ? '}' : ']';
        let depth = 0, inString = false, escape = false, endIdx = -1;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (inString) {
                if (escape) escape = false;
                else if (ch === '\\') escape = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') { inString = true; continue; }
            if (ch === open) depth++;
            else if (ch === close) { depth--; if (depth === 0) { endIdx = i; break; } }
        }
        if (endIdx === -1) return false;
        try { JSON.parse(s.slice(0, endIdx + 1)); } catch { return false; }
        // Bare JSON only if little/no prose follows the object.
        return s.slice(endIdx + 1).trim().length <= 40;
    }

    // Weak models sometimes emit a canned safety refusal ("I can't assist with that") for a perfectly
    // legitimate coding request. Detect a short reply that is essentially just such a refusal.
    private _looksLikeBogusRefusal(text: string): boolean {
        if (!text) return false;
        const s = text.trim();
        if (s.length > 200) return false;
        return /\b(i(?:'|\u2019)?m sorry|i am sorry|sorry|unfortunately)\b[^.]{0,40}\b(can(?:'|\u2019)?t|cannot|can not|not able to|unable to|won(?:'|\u2019)?t)\b[^.]{0,20}\b(assist|help|do that|comply|with that)\b/i.test(s)
            || /\bi\s+(can(?:'|\u2019)?t|cannot|can not|am (?:un)?able to|won(?:'|\u2019)?t)\s+(assist|help)\b/i.test(s);
    }

    private async _streamFromOllama(
        messages: { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }[],
        webview: vscode.Webview,
        depth = 0,
        retried = false,
        seenToolCalls: Set<string> = new Set()
    ): Promise<void> {
        if (depth >= OllamaViewProvider.MAX_AGENT_ITERATIONS) {
            webview.postMessage({ type: 'error', value: 'Stopped: too many tool-call iterations.' });
            return;
        }

        const config = vscode.workspace.getConfiguration('nrgbot');
        const toolsEnabled = config.get<boolean>('enableTools') ?? true;
        const projectContext = await this.getProjectContext();

        const result = await this._postChatCompletion(messages, webview, toolsEnabled, projectContext);
        if (!result) return; // error or abort already reported

        if (result.toolCalls.length === 0) {
            if (!result.content.trim()) {
                if (!retried) {
                    webview.postMessage({ type: 'retry' });
                    const reminder = 'Your previous response was empty. Answer the original user request now in plain English markdown. Use the attached file content already present in the conversation, and call a supplied read-only tool only if additional workspace evidence is required.';
                    const nudged = [
                        ...messages,
                        { role: 'assistant', content: null },
                        { role: 'user', content: reminder }
                    ];
                    await this._streamFromOllama(nudged, webview, depth + 1, true, seenToolCalls);
                    return;
                }
                webview.postMessage({
                    type: 'error',
                    value: 'The model returned an empty response twice. Try again or select another model.'
                });
                return;
            }
            if (!retried && this._looksLikeMissingFileAccess(result.content)) {
                webview.postMessage({ type: 'retry' });
                const lastUser = [...messages].reverse().find(message => message.role === 'user');
                const hasAttachment = typeof lastUser?.content === 'string'
                    && lastUser.content.includes('Attached file:');
                const reminder = missingAccessReminder(hasAttachment);
                const nudged = [
                    ...messages,
                    { role: 'assistant', content: result.content || null },
                    { role: 'user', content: reminder }
                ];
                await this._streamFromOllama(nudged, webview, depth + 1, true, seenToolCalls);
                return;
            }
            if (!retried && this._looksLikeBareJsonAnswer(result.content)) {
                webview.postMessage({ type: 'retry' });
                const reminder = 'Your previous reply was raw JSON, which is not a valid answer. Any file content you needed has already been provided. Answer the user\'s question now in plain English markdown prose. Do NOT output JSON, an "error" object, a "jsonrpc"/"result" object, or any protocol message.';
                const nudged = [
                    ...messages,
                    { role: 'assistant', content: result.content || null },
                    { role: 'user', content: reminder }
                ];
                await this._streamFromOllama(nudged, webview, depth + 1, true, seenToolCalls);
                return;
            }
            if (!retried && this._looksLikeBogusRefusal(result.content)) {
                webview.postMessage({ type: 'retry' });
                const reminder = 'That is a normal, allowed coding request about the user\'s own workspace code \u2014 do not refuse it. Complete it now: analyze or refactor the attached code and give your full answer in plain English markdown, including any improved code in fenced code blocks.';
                const nudged = [
                    ...messages,
                    { role: 'assistant', content: result.content || null },
                    { role: 'user', content: reminder }
                ];
                await this._streamFromOllama(nudged, webview, depth + 1, true, seenToolCalls);
                return;
            }
            webview.postMessage({ type: 'done' });
            return;
        }

        // This turn produced tool calls; any text it streamed is just the model echoing its own
        // call as JSON. Drop that draft (the tool-log badges stay) so the real answer replaces it.
        webview.postMessage({ type: 'clearDraft' });

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
            const signature = `${tc.name}(${(tc.arguments || '').trim()})`;
            if (seenToolCalls.has(signature)) {
                // Same call already ran this turn; refuse to repeat it and steer the model forward.
                nextMessages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: `You already called ${tc.name} with these exact arguments and received its result earlier. Do not call it again. Answer the user now using that result, or call a different tool (to read one file's contents use read_file with its "path").`
                });
                continue;
            }
            seenToolCalls.add(signature);

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

        await this._streamFromOllama(nextMessages, webview, depth + 1, false, seenToolCalls);
    }

    private _postChatCompletion(
        messages: { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }[],
        webview: vscode.Webview,
        toolsEnabled: boolean,
        projectContext: ProjectContext
    ): Promise<{ content: string; toolCalls: { id: string; name: string; arguments: string }[] } | null> {
        return new Promise((resolve) => {
            if (this.activeRequest) {
                vscode.window.showWarningMessage('NRGBot: A response is already in progress.');
                resolve(null);
                return;
            }

            const config = vscode.workspace.getConfiguration('nrgbot');
            const configuredUrl = config.get<string>('serverUrl') || 'http://192.168.3.142:11434';
            const modelName = config.get<string>('modelName') || 'qwen2.5-coder:14b';

            let parsedUrl: URL;
            try {
                parsedUrl = new URL(configuredUrl);
            } catch (err) {
                parsedUrl = new URL('http://192.168.3.142:11434');
            }

            const isHttps = parsedUrl.protocol === 'https:';
            const transport = isHttps ? https : http;

            // Attachment mode is decided by the CURRENT turn only: scanning the whole history would
            // keep every later message in attachment mode (dropping project knowledge and tools) long
            // after the user removed the chip.
            const lastUser = [...messages].reverse().find(m => m.role === 'user' && typeof m.content === 'string');
            const hasAttachment = typeof lastUser?.content === 'string' && lastUser.content.includes('Attached file:');
            const isFileAction = this._questionIsFileAction(messages);
            const maxContextChars = config.get<number>('projectContextMaxChars') ?? DEFAULT_CONTEXT_MAX_CHARS;
            const requestContext = budgetProjectContext(projectContext, maxContextChars, hasAttachment);
            const hasKnowledge = !!(requestContext.knowledge || requestContext.map);
            // After a tool has run, its result is in the conversation; switch to the answer-once prompt.
            const hasToolResults = messages.some(m => m.role === 'tool');
            const { offerTools, fileAction, injectKnowledge } = determineRequestRouting({
                toolsEnabled,
                hasAttachment,
                attachmentNeedsWorkspaceLookup: hasAttachment && this._questionNeedsWorkspaceLookup(messages),
                isFileAction,
                hasToolResults,
                hasKnowledge
            });
            const systemMessage = {
                role: 'system',
                content: this.buildSystemPrompt(requestContext, { hasAttachment, offerTools, fileAction, hasToolResults })
            };
            const contextMessage = injectKnowledge
                ? buildBaselineContextMessage(requestContext)
                : undefined;
            // Ollama defaults to 0.8, which makes a small model ramble and drift off the grounded
            // context; a low temperature keeps answers factual and repeatable.
            const temperature = config.get<number>('temperature') ?? 0.2;
            const postData = JSON.stringify({
                model: modelName,
                messages: composeRequestMessages(systemMessage, messages, contextMessage),
                stream: true,
                temperature,
                ...(offerTools ? { tools: TOOLS } : {})
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
                const processSseLine = (line: string) => {
                    if (!line.trim().startsWith('data: ')) {
                        return;
                    }
                    const payload = line.trim().substring(6);
                    if (payload === '[DONE]') {
                        return;
                    }
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
                };
                res.on('data', (chunk) => {
                    const complete = takeCompleteLines(buffer + chunk.toString());
                    buffer = complete.remainder;
                    for (const line of complete.lines) {
                        processSseLine(line);
                    }
                });
                res.on('end', () => {
                    for (const line of takeCompleteLines(buffer, true).lines) {
                        processSseLine(line);
                    }
                    buffer = '';
                    if (!jsonPrefixDecided && displayBuffer) {
                        // Never resolved into a full tool-call JSON blob (e.g. truncated); show it rather than dropping it.
                        webview.postMessage({ type: 'token', value: displayBuffer });
                    }
                    let toolCalls = [...toolCallAccum.values()].filter(tc => tc.name);
                    // Some models write a tool call as plain JSON text (sometimes followed by their real answer)
                    // instead of using the tool_calls delta, or echo the call back before/alongside their answer.
                    const leading = extractLeadingToolCallJson(content);
                    if (leading) {
                        // A leading tool-call JSON is a real (mis-formatted) call even when the model tacks on a
                        // short hallucinated "result" sentence after it. Only keep it as prose if a substantial
                        // answer or a code block follows (i.e. the JSON was a genuine example, not an actual call).
                        const restIsNoise = leading.rest.trim() === ''
                            || (isKnownTool(leading.name)
                                && !leading.rest.includes('```')
                                && leading.rest.trim().length <= 200);
                        if (toolCalls.length === 0 && restIsNoise) {
                            toolCalls = [{ id: `fallback-${Date.now()}`, name: leading.name, arguments: leading.arguments }];
                            content = '';
                            // The raw JSON already streamed to the view; clear it so the real result replaces it.
                            webview.postMessage({ type: 'retry' });
                        } else {
                            content = leading.rest;
                        }
                    }
                    // Weaker models sometimes bury the tool-call JSON inside prose rather than leading with it.
                    // A tool call means the model hasn't produced its answer yet, so only prose that FOLLOWS the
                    // JSON signals a genuine answer; leading narration ("I'll call list_files ... here it is:") is
                    // fine. Reject only when a real answer or a code block wraps the JSON (a genuine example).
                    if (toolCalls.length === 0) {
                        const embedded = findToolCallJson(content);
                        if (embedded && isKnownTool(embedded.name)) {
                            const after = content.slice(embedded.endIdx + 1);
                            // A tool call means the model hasn't answered yet, so only substantial prose AFTER
                            // the JSON signals a genuine answer; leading narration and ```json fencing are fine.
                            const afterProse = after.replace(/<\/?tool_call>/gi, '').replace(/```(?:json)?/gi, '').trim();
                            if (afterProse.length <= 40) {
                                toolCalls = [{ id: `fallback-${Date.now()}`, name: embedded.name, arguments: embedded.arguments }];
                                content = '';
                                // The raw JSON already streamed to the view; clear it so the real result replaces it.
                                webview.postMessage({ type: 'retry' });
                            }
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
                if (settled) {
                    return;
                }
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
            req.setTimeout(OllamaViewProvider.CHAT_REQUEST_TIMEOUT_MS, () => {
                if (settled) {
                    return;
                }
                const message = 'The model did not send data for 120 seconds. Try again or select another model.';
                webview.postMessage({ type: content.length > 0 ? 'streamError' : 'error', value: message });
                finish(null);
                req.destroy();
            });
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
