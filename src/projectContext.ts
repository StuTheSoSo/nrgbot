import * as vscode from 'vscode';

export const DEFAULT_KNOWLEDGE_FILE = '.nrgbot/knowledge.md';
export const DEFAULT_RULES_FILE = '.nrgbot/refactor-rules.md';
export const DEFAULT_CONTEXT_MAX_CHARS = 6000;

export const REFACTOR_RULES_TEMPLATE = `# Refactoring rules

<!-- NRGBot follows these rules on every attached-file coding request. Be concrete and imperative. -->

## Style
- Keep changes minimal and focused; do not rewrite unrelated code.
- Preserve existing public APIs and behavior unless explicitly asked to change them.

## Naming
- Follow the surrounding file's naming and formatting conventions.

## Structure
- Prefer small, well-named methods over large blocks.

## Comments
- Keep comments short; explain only what the code cannot show on its own.
`;

export const KNOWLEDGE_DOC_TEMPLATE = `# Project knowledge

## Purpose
<!-- What is this solution and who uses it? -->

## Architecture
<!-- High-level components and how they fit together. -->

## Key projects & entry points
<!-- Important projects, executables/libraries, and where to start reading. -->

## Conventions
<!-- Coding standards, patterns, naming, or gotchas the model should know. -->
`;

export interface ProjectEntry {
    name: string;
    /** Project path exactly as written in the .sln (may use backslashes). */
    relPath: string;
}

function getWorkspaceRoot(): vscode.Uri | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri : undefined;
}

function basename(uriPath: string): string {
    return uriPath.split('/').pop() || uriPath;
}

/** Cap text to a character budget, leaving a visible truncation note. */
export function applyBudget(text: string, maxChars: number): string {
    if (maxChars <= 0 || text.length <= maxChars) {
        return text;
    }
    const note = '\n... [context truncated to fit budget]';
    const keep = Math.max(0, maxChars - note.length);
    return text.slice(0, keep).trimEnd() + note;
}

/** Extract real project entries from .sln text, skipping solution folders. */
export function parseSolutionProjects(slnText: string): ProjectEntry[] {
    const re = /Project\("\{[^}]+\}"\)\s*=\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"\{[^}]+\}"/g;
    const out: ProjectEntry[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(slnText)) !== null) {
        const name = m[1].trim();
        const relPath = m[2].trim();
        if (/\.(csproj|vcxproj|vbproj|fsproj|shproj)$/i.test(relPath)) {
            out.push({ name, relPath });
        }
    }
    return out;
}

export function languageFromExt(relPath: string): string {
    const ext = relPath.toLowerCase().split('.').pop();
    switch (ext) {
        case 'csproj': return 'C#';
        case 'vcxproj': return 'C++';
        case 'vbproj': return 'VB';
        case 'fsproj': return 'F#';
        default: return 'project';
    }
}

/** Pull a short list of facts (framework/output or config/toolset) from a project file. */
export function extractProjectFacts(projText: string, relPath: string): string[] {
    const facts: string[] = [];
    const ext = relPath.toLowerCase().split('.').pop();
    if (ext === 'vcxproj') {
        const cfg = /<ConfigurationType>\s*([^<]+?)\s*<\/ConfigurationType>/i.exec(projText);
        if (cfg) facts.push(cfg[1].trim());
        const tool = /<PlatformToolset>\s*([^<]+?)\s*<\/PlatformToolset>/i.exec(projText);
        if (tool) facts.push(tool[1].trim());
    } else {
        const tf = /<TargetFrameworks?>\s*([^<]+?)\s*<\/TargetFrameworks?>/i.exec(projText)
            || /<TargetFrameworkVersion>\s*([^<]+?)\s*<\/TargetFrameworkVersion>/i.exec(projText);
        if (tf) facts.push(tf[1].trim());
        const out = /<OutputType>\s*([^<]+?)\s*<\/OutputType>/i.exec(projText);
        if (out) facts.push(out[1].trim());
    }
    return facts;
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(bytes).toString('utf8');
    } catch {
        return undefined;
    }
}

/** Read the hand-authored knowledge doc, if present, capped to budget. */
export async function readKnowledgeDoc(fileRel: string, maxChars: number): Promise<string> {
    const root = getWorkspaceRoot();
    if (!root) {
        return '';
    }
    const uri = vscode.Uri.joinPath(root, fileRel);
    const text = (await readText(uri))?.trim();
    return text ? applyBudget(text, maxChars) : '';
}

async function topLevelFolders(root: vscode.Uri): Promise<string> {
    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(root);
    } catch {
        return '';
    }
    const dirs = entries
        .filter(([name, type]) => type === vscode.FileType.Directory && !name.startsWith('.'))
        .map(([name]) => name);
    return dirs.length ? `Top-level folders: ${dirs.join(', ')}` : '';
}

async function overviewWithoutSolution(root: vscode.Uri): Promise<string> {
    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(root);
    } catch {
        return '';
    }
    const dirs = entries.filter(([, t]) => t === vscode.FileType.Directory).map(([n]) => n);
    const files = entries.filter(([, t]) => t !== vscode.FileType.Directory).map(([n]) => n);
    const lines = ['No .sln found. Top-level workspace layout:'];
    if (dirs.length) lines.push(`Folders: ${dirs.join(', ')}`);
    if (files.length) lines.push(`Files: ${files.join(', ')}`);
    return lines.join('\n');
}

async function describeSolution(sln: vscode.Uri): Promise<string> {
    const slnName = basename(sln.path);
    const text = await readText(sln);
    if (text === undefined) {
        return `Solution: ${slnName} (unreadable)`;
    }
    const projects = parseSolutionProjects(text);
    const slnDir = vscode.Uri.joinPath(sln, '..');
    const lines = [`Solution: ${slnName} (${projects.length} project${projects.length === 1 ? '' : 's'})`];
    for (const p of projects) {
        const segments = p.relPath.replace(/\\/g, '/').split('/');
        const projUri = vscode.Uri.joinPath(slnDir, ...segments);
        const projText = await readText(projUri);
        const facts = projText ? extractProjectFacts(projText, p.relPath) : [];
        const folder = vscode.workspace.asRelativePath(vscode.Uri.joinPath(projUri, '..'));
        const meta = [languageFromExt(p.relPath), ...facts].join(', ');
        lines.push(`- ${p.name} (${meta}) — ${folder}`);
    }
    return lines.join('\n');
}

/** Build a compact map of the open solution(s), capped to budget. */
export async function generateProjectMap(maxChars: number): Promise<string> {
    const root = getWorkspaceRoot();
    if (!root) {
        return '';
    }
    const slnFiles = await vscode.workspace.findFiles('**/*.sln', '**/node_modules/**', 10);
    if (slnFiles.length === 0) {
        return applyBudget(await overviewWithoutSolution(root), maxChars);
    }
    const parts: string[] = [];
    const folders = await topLevelFolders(root);
    if (folders) {
        parts.push(folders);
    }
    for (const sln of slnFiles) {
        parts.push(await describeSolution(sln));
    }
    return applyBudget(parts.join('\n\n'), maxChars);
}
