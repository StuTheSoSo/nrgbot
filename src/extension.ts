import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { TOOLS, executeTool, isKnownTool } from './tools';
import { extractLeadingToolCallJson, findToolCallJson } from './parsing';
import {
    DEFAULT_KNOWLEDGE_FILE,
    DEFAULT_CONTEXT_MAX_CHARS,
    KNOWLEDGE_DOC_TEMPLATE,
    readKnowledgeDoc,
    generateProjectMap
} from './projectContext';

export function activate(context: vscode.ExtensionContext) {
    const previewProvider = new ApplyPreviewProvider();
    const provider = new OllamaViewProvider(context.extensionUri, previewProvider);

    const projectWatcher = vscode.workspace.createFileSystemWatcher('**/*.{sln,csproj,vcxproj}');
    const invalidate = () => provider.invalidateProjectContext();
    projectWatcher.onDidCreate(invalidate);
    projectWatcher.onDidChange(invalidate);
    projectWatcher.onDidDelete(invalidate);

    // The knowledge doc path is configurable, so the watcher is rebuilt when the setting changes.
    let knowledgeWatcher: vscode.FileSystemWatcher | undefined;
    const rebuildKnowledgeWatcher = () => {
        knowledgeWatcher?.dispose();
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            knowledgeWatcher = undefined;
            return;
        }
        const file = vscode.workspace.getConfiguration('nrgbot').get<string>('knowledgeFile') || DEFAULT_KNOWLEDGE_FILE;
        knowledgeWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folders[0], file));
        knowledgeWatcher.onDidCreate(invalidate);
        knowledgeWatcher.onDidChange(invalidate);
        knowledgeWatcher.onDidDelete(invalidate);
    };
    rebuildKnowledgeWatcher();

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(ApplyPreviewProvider.scheme, previewProvider),
        vscode.window.registerWebviewViewProvider('ollama.chatSidebarView', provider),
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) provider.lastActiveEditor = editor;
        }),
        vscode.window.tabGroups.onDidChangeTabs(() => provider.syncPendingEditWithOpenTabs()),
        projectWatcher,
        { dispose: () => knowledgeWatcher?.dispose() },
        vscode.workspace.onDidChangeConfiguration(e => {
            if (!e.affectsConfiguration('nrgbot')) return;
            invalidate();
            if (e.affectsConfiguration('nrgbot.knowledgeFile')) rebuildKnowledgeWatcher();
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            invalidate();
            rebuildKnowledgeWatcher();
        }),
        vscode.commands.registerCommand('nrgbot.refreshProjectContext', async () => {
            provider.invalidateProjectContext();
            await provider.warmProjectContext();
            vscode.window.showInformationMessage('NRGBot: project context refreshed.');
        }),
        vscode.commands.registerCommand('nrgbot.applyProposedEdit', () => provider.applyProposedEdit()),
        vscode.commands.registerCommand('nrgbot.discardProposedEdit', () => provider.discardProposedEdit()),
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
    private projectContext: { knowledge: string; map: string } | undefined;
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

    /** Drop the cached project context so the next request regenerates it. */
    public invalidateProjectContext(): void {
        this.projectContext = undefined;
    }

    /** Eagerly (re)build the cached project context, e.g. from the refresh command. */
    public async warmProjectContext(): Promise<void> {
        await this.getProjectContext();
    }

    private async getProjectContext(): Promise<{ knowledge: string; map: string }> {
        if (this.projectContext) return this.projectContext;
        const config = vscode.workspace.getConfiguration('nrgbot');
        const knowledgeFile = config.get<string>('knowledgeFile') || DEFAULT_KNOWLEDGE_FILE;
        const includeMap = config.get<boolean>('includeProjectMap') !== false;
        const maxChars = config.get<number>('projectContextMaxChars') ?? DEFAULT_CONTEXT_MAX_CHARS;
        const knowledge = await readKnowledgeDoc(knowledgeFile, maxChars);
        const map = includeMap ? await generateProjectMap(maxChars) : '';
        this.projectContext = { knowledge, map };
        return this.projectContext;
    }

    private static readonly BASE_SYSTEM_PROMPT = 'You are a coding assistant inside VS Code. The user\'s message may already include attached file content in fenced code blocks, each preceded by a line like "Attached file: <name>". That attached content IS the file the user is referring to; treat it as fully available and answer from it directly. Never call read_file or list_directory for a file whose content is already attached, and never claim an attached file does not exist. Do not echo or quote the complete attached file unless the user explicitly asks for it. You have read-only tools (read_file, list_directory, search_text, list_files) that give you direct access to every file in the workspace. When a question needs file contents, sizes, line counts, or the largest files, CALL THE TOOLS to gather the facts instead of asking the user to attach files or emitting placeholder values. Use list_files (with sortBy and limit) for questions about file sizes, line counts, or largest files. Never guess or fabricate file data. Never write JSON tool calls in your response. Only call tools supplied in this request; never invent a tool such as analyze_code_quality. Analyze attached code directly in your normal response. After a tool returns its result, write your final answer as plain English markdown prose. Never output JSON, JSON-RPC, an "error"/"result"/"jsonrpc" object, or any protocol message as your answer; the tool result is the real file content, so use it to answer the question. When the user asks about the project, solution, or architecture, base your answer ONLY on the "## Project knowledge" and "## Solution map" sections below. Do not invent project names, and never claim the solution uses a framework, engine, or technology (such as Unity, React, or a game engine) unless it appears in those sections. If that context does not cover the question, say what you can from it and that you do not have more detail rather than guessing.';

    // Used when the message already carries an attached file: no tools are offered, so the prompt
    // must not mention them or a weak model will still write a tool call as text and stall.
    private static readonly ATTACHMENT_SYSTEM_PROMPT = 'You are a coding assistant inside VS Code. The user\'s message includes attached file content in fenced code blocks, each preceded by a line like "Attached file: <name>". That attached content IS the file the user is asking about and is fully available to you. Analyze it directly and answer in plain English markdown prose. You have NO tools available: do not call, request, or mention any tool (read_file, list_files, etc.), do not ask the user to run or confirm anything, and do not ask for the file or claim you lack access. Never output JSON, a tool call, an "error"/"result"/"jsonrpc" object, or any protocol message \u2014 just write your analysis. Do not echo or quote the entire file unless the user explicitly asks.';

    // Attached file PLUS a question that needs other files (usages, references, callers): tools stay on.
    private static readonly ATTACHMENT_WITH_TOOLS_SYSTEM_PROMPT = 'You are a coding assistant inside VS Code. The user\'s message includes attached file content in fenced code blocks, each preceded by a line like "Attached file: <name>"; treat that attached content as fully available. The user\'s question needs information from OTHER files in the workspace (for example, where a symbol is used or referenced). Use the read-only tools to find it: search_text to find where a name appears across the workspace, list_files to locate files, and read_file to inspect another file. Call one tool at a time and wait for its result before the next. After the tools return, write your final answer as plain English markdown prose that cites the files and lines you found. Never ask the user to attach or paste files, never say you lack workspace access, and never output JSON, a bare tool call, or any protocol message as your final answer.';

    private buildSystemPrompt(
        context: { knowledge: string; map: string },
        opts: { hasAttachment?: boolean; offerTools?: boolean } = {}
    ): string {
        if (opts.hasAttachment) {
            return opts.offerTools
                ? OllamaViewProvider.ATTACHMENT_WITH_TOOLS_SYSTEM_PROMPT
                : OllamaViewProvider.ATTACHMENT_SYSTEM_PROMPT;
        }
        const parts = [OllamaViewProvider.BASE_SYSTEM_PROMPT];
        if (context.knowledge) {
            parts.push('## Project knowledge (Starfish)\n' + context.knowledge);
        }
        if (context.map) {
            parts.push('## Solution map\n' + context.map);
        }
        return parts.join('\n\n');
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

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
        const scriptUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'webview.js'));
        const codiconUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'codicon.css'));
        const csp = `default-src 'none'; style-src ${webviewView.webview.cspSource} 'unsafe-inline'; script-src ${webviewView.webview.cspSource}; font-src ${webviewView.webview.cspSource};`;

        webviewView.webview.html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <link href="${codiconUri}" rel="stylesheet" />
    <style>
        :root {
            --nrg-accent: #3fb950;
            --nrg-accent-hover: #4fc862;
            --nrg-accent-soft: rgba(63, 185, 80, 0.14);
            --nrg-accent-border: rgba(63, 185, 80, 0.42);
            --nrg-radius: 10px;
        }
        * { box-sizing: border-box; }
        html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
        body { display: flex; flex-direction: column; font-family: var(--vscode-font-family, sans-serif); font-size: 13px; padding: 10px; color: var(--vscode-foreground); }

        /* Header / branding */
        .app-header { display: flex; align-items: center; gap: 8px; padding-bottom: 8px; margin-bottom: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
        .brand { display: flex; align-items: center; gap: 7px; font-weight: 600; letter-spacing: 0.2px; }
        .brand-mark { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 6px; background: var(--nrg-accent-soft); color: var(--nrg-accent); border: 1px solid var(--nrg-accent-border); }
        .brand-mark .codicon { font-size: 15px; }
        .brand-name b { color: var(--nrg-accent); }
        .header-actions { margin-left: auto; display: flex; gap: 4px; }
        .icon-btn { width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: transparent; color: var(--vscode-foreground); border: 1px solid transparent; border-radius: 6px; cursor: pointer; margin: 0; }
        .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.15)); }
        .icon-btn .codicon { font-size: 16px; }

        /* Chat area */
        #chat-box { flex: 1; overflow-y: auto; padding: 4px 2px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 14px; }
        .msg { display: flex; gap: 9px; align-items: flex-start; animation: nrg-fade 0.18s ease-out; }
        @keyframes nrg-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        .msg-avatar { flex: 0 0 auto; width: 26px; height: 26px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; }
        .msg-avatar .codicon { font-size: 14px; }
        .msg.user .msg-avatar { background: var(--vscode-input-background); color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); }
        .msg.ai .msg-avatar { background: var(--nrg-accent-soft); color: var(--nrg-accent); border: 1px solid var(--nrg-accent-border); }
        .msg-body { flex: 1; min-width: 0; }
        .msg-author { font-size: 11px; font-weight: 600; opacity: 0.7; margin-bottom: 3px; letter-spacing: 0.3px; }
        .msg.ai .msg-author { color: var(--nrg-accent); opacity: 0.9; }
        .msg-content { border-radius: var(--nrg-radius); padding: 8px 11px; line-height: 1.5; overflow-wrap: anywhere; }
        .msg.user .msg-content { background: var(--nrg-accent-soft); border: 1px solid var(--nrg-accent-border); white-space: pre-wrap; }
        .msg.ai .msg-content { background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.08)); border: 1px solid var(--vscode-panel-border); }
        .msg-content > :first-child { margin-top: 0; }
        .msg-content > :last-child { margin-bottom: 0; }
        .msg-content p, .msg-content ul, .msg-content ol { margin: 0.4em 0; }
        .msg-content code { font-family: var(--vscode-editor-font-family, monospace); background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 4px; font-size: 0.92em; }
        .msg-content h1, .msg-content h2, .msg-content h3 { margin: 0.6em 0 0.3em; line-height: 1.3; }

        /* Code blocks */
        .code-block { margin: 0.5em 0; border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden; background: var(--vscode-textCodeBlock-background); }
        .code-head { display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: var(--vscode-editorGroupHeader-tabsBackground, rgba(127,127,127,0.12)); border-bottom: 1px solid var(--vscode-panel-border); }
        .code-lang { font-size: 11px; text-transform: lowercase; opacity: 0.7; font-family: var(--vscode-editor-font-family, monospace); }
        .code-head-actions { margin-left: auto; display: flex; gap: 2px; }
        .code-head-actions .icon-btn { width: 22px; height: 22px; }
        .code-head-actions .icon-btn .codicon { font-size: 13px; }
        .code-block pre { margin: 0; padding: 9px 11px; overflow-x: auto; background: none; }
        .code-block pre code { padding: 0; background: none; font-size: 0.9em; }

        /* Tables */
        .md-table { border-collapse: collapse; margin: 0.5em 0; font-size: 0.9em; max-width: 100%; display: block; overflow-x: auto; }
        .md-table th, .md-table td { border: 1px solid var(--vscode-panel-border); padding: 5px 9px; text-align: left; }
        .md-table th { background: var(--vscode-textBlockQuote-background); font-weight: 600; }

        /* Tool notes, typing, status */
        .tool-note { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; opacity: 0.8; font-family: var(--vscode-editor-font-family, monospace); margin: 3px 0; padding: 2px 8px; background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); border-radius: 20px; }
        .tool-note .codicon { font-size: 12px; color: var(--nrg-accent); }
        .typing { display: inline-flex; gap: 4px; padding: 5px 2px; align-items: center; }
        .typing span { width: 6px; height: 6px; border-radius: 50%; background: var(--nrg-accent); animation: nrg-typing 1s infinite ease-in-out; }
        .typing span:nth-child(2) { animation-delay: 0.15s; }
        .typing span:nth-child(3) { animation-delay: 0.3s; }
        @keyframes nrg-typing { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-4px); opacity: 1; } }
        .stream-status.failed { display: flex; align-items: center; gap: 6px; margin-top: 8px; padding: 6px 9px; border-radius: 6px; font-size: 12px; color: var(--vscode-inputValidation-warningForeground, var(--vscode-editor-foreground)); background: var(--vscode-inputValidation-warningBackground, rgba(181,137,0,0.15)); border: 1px solid var(--vscode-inputValidation-warningBorder, #b58900); }
        .msg-footer { display: flex; gap: 6px; margin-top: 8px; }

        /* Empty / welcome state */
        .welcome { margin: auto; text-align: center; padding: 24px 16px; }
        .welcome-mark { width: 46px; height: 46px; border-radius: 12px; background: var(--nrg-accent-soft); color: var(--nrg-accent); border: 1px solid var(--nrg-accent-border); display: inline-flex; align-items: center; justify-content: center; margin-bottom: 12px; }
        .welcome-mark .codicon { font-size: 26px; }
        .welcome h2 { margin: 0 0 4px; font-size: 15px; }
        .welcome h2 b { color: var(--nrg-accent); }
        .welcome p { margin: 0 0 14px; font-size: 12px; opacity: 0.75; }
        .welcome-hints { display: flex; flex-direction: column; gap: 6px; max-width: 250px; margin: 0 auto; }
        .welcome-hint { display: flex; align-items: center; gap: 8px; text-align: left; font-size: 12px; padding: 7px 10px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: var(--vscode-input-background); }
        .welcome-hint .codicon { color: var(--nrg-accent); font-size: 14px; flex: 0 0 auto; }

        /* Bottom tray */
        .bottom-tray { display: flex; flex-direction: column; width: 100%; gap: 7px; }
        #attachments { display: flex; flex-wrap: wrap; gap: 6px; }
        #attachments:empty { display: none; }
        .chip { display: inline-flex; align-items: center; gap: 5px; background: var(--nrg-accent-soft); color: var(--vscode-foreground); border: 1px solid var(--nrg-accent-border); padding: 3px 8px; border-radius: 20px; font-size: 11px; max-width: 100%; }
        .chip-icon { color: var(--nrg-accent); font-size: 12px; }
        .chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
        .chip-close { cursor: pointer; opacity: 0.6; font-size: 13px; display: inline-flex; }
        .chip-close:hover { opacity: 1; color: var(--vscode-inputValidation-errorForeground, #f14c4c); }
        .tray-row { display: flex; gap: 6px; }
        .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 6px 10px; background: var(--vscode-button-secondaryBackground, var(--vscode-input-background)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-panel-border); border-radius: 7px; cursor: pointer; font-size: 12px; margin: 0; width: auto; }
        .btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.15))); }
        .btn .codicon { font-size: 14px; }
        .btn.grow { flex: 1; }
        textarea { width: 100%; min-height: 62px; max-height: 200px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 8px; resize: none; padding: 8px 10px; font-family: inherit; font-size: 13px; box-sizing: border-box; }
        textarea:focus { outline: none; border-color: var(--nrg-accent); box-shadow: 0 0 0 1px var(--nrg-accent-border); }
        .btn-primary { display: inline-flex; align-items: center; justify-content: center; gap: 7px; width: 100%; padding: 8px; background: var(--nrg-accent); color: #08260f; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 13px; margin: 0; }
        .btn-primary:hover { background: var(--nrg-accent-hover); }
        .btn-primary .codicon { font-size: 15px; }
        #send-btn.stop-mode { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-inputValidation-errorForeground, #fff); }
        #send-btn.stop-mode:hover { background: var(--vscode-inputValidation-errorBorder, #be1100); }

        /* Settings panel */
        .settings-panel { border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); padding: 10px; margin-bottom: 10px; border-radius: 8px; }
        .settings-label { display: block; font-size: 10px; opacity: 0.7; margin: 8px 0 3px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
        .settings-label:first-child { margin-top: 0; }
        .settings-row { display: flex; gap: 5px; align-items: center; }
        .settings-row input, .settings-row select { flex: 1; min-width: 0; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 6px; padding: 5px 7px; box-sizing: border-box; font-size: 12px; }
        .settings-row input:focus, .settings-row select:focus { outline: none; border-color: var(--nrg-accent); }
        .settings-status { font-size: 11px; margin-top: 8px; min-height: 1em; opacity: 0.85; display: flex; align-items: center; gap: 5px; }
        .settings-status .codicon { color: var(--nrg-accent); font-size: 13px; }
        .settings-status.error { color: var(--vscode-inputValidation-warningForeground, #b58900); }
        .settings-status.error .codicon { color: var(--vscode-inputValidation-warningForeground, #b58900); }
    </style>
</head>
<body>
    <div class="app-header">
        <div class="brand">
            <span class="brand-mark"><i class="codicon codicon-zap"></i></span>
            <span class="brand-name">NRG<b>Bot</b></span>
        </div>
        <div class="header-actions">
            <button id="settings-btn" class="icon-btn" title="Settings"><i class="codicon codicon-settings-gear"></i></button>
            <button id="clear-btn" class="icon-btn" title="New chat"><i class="codicon codicon-add"></i></button>
        </div>
    </div>
    <div id="settings-panel" class="settings-panel" style="display:none;">
        <label class="settings-label" for="server-url">Server URL</label>
        <div class="settings-row">
            <input id="server-url" type="text" placeholder="http://localhost:11434" />
            <button id="connect-btn" class="btn" title="Connect &amp; refresh models"><i class="codicon codicon-plug"></i> Connect</button>
        </div>
        <label class="settings-label" for="model-select">Model</label>
        <div class="settings-row">
            <select id="model-select"></select>
            <button id="refresh-models-btn" class="icon-btn" title="Refresh model list"><i class="codicon codicon-refresh"></i></button>
        </div>
        <div id="settings-status" class="settings-status"></div>
    </div>
    <div id="chat-box"></div>

    <div class="bottom-tray">
        <div id="attachments"></div>
        <div class="tray-row">
            <button id="grab-btn" class="btn grow"><i class="codicon codicon-list-selection"></i> Selection</button>
            <button id="page-btn" class="btn grow"><i class="codicon codicon-file-code"></i> Full Page</button>
        </div>
        <textarea id="prompt" placeholder="Ask NRGBot\u2026"></textarea>
        <button id="send-btn" class="btn-primary"><i class="codicon codicon-send"></i> Send</button>
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
            || /(attach|provide|share|paste)\b[^.]{0,50}\b(file|files|code|contents?)\b/i.test(text)
            || /\bI (do not|don'?t) have (direct )?(access|visibility)\b/i.test(text)
            || /\bwithout (access to|seeing|the actual)\b/i.test(text);
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
            if (toolsEnabled && !retried && this._looksLikeMissingFileAccess(result.content)) {
                webview.postMessage({ type: 'retry' });
                const reminder = 'You answered without calling any tool. You have direct read-only access to the workspace: use list_files (with sortBy and limit) for file sizes, line counts, or the largest files, and read_file to inspect a file. Call the appropriate tool now and answer from the real results. Do not ask the user to attach files, and never use hypothetical or placeholder values.';
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
        projectContext: { knowledge: string; map: string }
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

            const hasAttachment = messages.some(m =>
                m.role === 'user' && typeof m.content === 'string' && m.content.includes('Attached file:'));
            // Attaching a file normally suppresses tools (keeps a small model focused on the paste),
            // but cross-file questions (usages/references) still need them, so re-enable in that case.
            const offerTools = toolsEnabled && (!hasAttachment || this._questionNeedsWorkspaceLookup(messages));
            const systemMessage = {
                role: 'system',
                content: this.buildSystemPrompt(projectContext, { hasAttachment, offerTools })
            };
            const postData = JSON.stringify({
                model: modelName,
                messages: [systemMessage, ...messages],
                stream: true,
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
                    // Only treat it as a real call when the JSON is essentially the whole message; otherwise it is
                    // a genuine answer that merely contains JSON (a code sample or an echoed example), and hijacking
                    // it would wipe the answer and restart the turn in a loop.
                    if (toolCalls.length === 0) {
                        const embedded = findToolCallJson(content);
                        if (embedded && isKnownTool(embedded.name)) {
                            const before = content.slice(0, embedded.startIdx);
                            const after = content.slice(embedded.endIdx + 1);
                            const proseAround = (before + after)
                                .replace(/<\/?tool_call>/gi, '')
                                .replace(/```(?:json)?/gi, '')
                                .trim();
                            if (proseAround.length <= 40) {
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
