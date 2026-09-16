import * as vscode from 'vscode';

const MAX_TOOL_OUTPUT_CHARS = 20000;
const MAX_SEARCH_MATCHES = 50;

export const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the full contents of a file in the current workspace.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Workspace-relative file path, e.g. src/extension.ts' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_directory',
            description: 'List the files and folders inside a directory in the current workspace.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Workspace-relative directory path. Use "." for the workspace root.' }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_text',
            description: 'Search for a text or regular expression pattern across files in the current workspace and return matching lines.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Text or regular expression to search for' },
                    globPattern: { type: 'string', description: 'Optional glob to restrict which files are searched, e.g. **/*.ts' }
                },
                required: ['query']
            }
        }
    }
];

function truncate(s: string): string {
    return s.length > MAX_TOOL_OUTPUT_CHARS ? s.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n... [truncated]' : s;
}

function resolveWorkspacePath(relPath: string): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        throw new Error('No workspace folder is open.');
    }
    const base = folders[0].uri;
    const target = vscode.Uri.joinPath(base, relPath || '.');
    // Prevent path traversal outside the workspace folder.
    if (!target.fsPath.startsWith(base.fsPath)) {
        throw new Error('Path escapes the workspace folder.');
    }
    return target;
}

async function readFileTool(relPath: string): Promise<string> {
    const uri = resolveWorkspacePath(relPath);
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return truncate(Buffer.from(bytes).toString('utf8'));
    } catch {
        // Literal path missing: the model often passes a namespace-style or bare name. Fall back to a basename search.
        const found = await findFileByBasename(relPath);
        if (!found) {
            throw new Error(`File not found: ${relPath}`);
        }
        const bytes = await vscode.workspace.fs.readFile(found);
        return `(resolved to ${vscode.workspace.asRelativePath(found)})\n` + truncate(Buffer.from(bytes).toString('utf8'));
    }
}

async function findFileByBasename(relPath: string): Promise<vscode.Uri | undefined> {
    const basename = relPath.split(/[\\/]/).pop() ?? relPath;
    if (!basename) return undefined;
    const matches = await vscode.workspace.findFiles(`**/${basename}`, '**/node_modules/**', 2);
    return matches[0];
}

async function listDirectoryTool(relPath: string): Promise<string> {
    const uri = resolveWorkspacePath(relPath || '.');
    const entries = await vscode.workspace.fs.readDirectory(uri);
    if (entries.length === 0) return '(empty)';
    return entries
        .map(([name, type]) => `${type === vscode.FileType.Directory ? '📁' : '📄'} ${name}`)
        .join('\n');
}

async function searchTextTool(query: string, globPattern?: string): Promise<string> {
    const files = await vscode.workspace.findFiles(globPattern || '**/*', '**/node_modules/**', 500);
    let regex: RegExp;
    try {
        regex = new RegExp(query, 'i');
    } catch {
        regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    const matches: string[] = [];
    for (const file of files) {
        if (matches.length >= MAX_SEARCH_MATCHES) break;
        try {
            const bytes = await vscode.workspace.fs.readFile(file);
            const text = Buffer.from(bytes).toString('utf8');
            const lines = text.split('\n');
            for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i++) {
                if (regex.test(lines[i])) {
                    matches.push(`${vscode.workspace.asRelativePath(file)}:${i + 1}: ${lines[i].trim()}`);
                }
            }
        } catch {
            // Skip unreadable/binary files.
        }
    }
    return matches.length ? truncate(matches.join('\n')) : 'No matches found.';
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    try {
        switch (name) {
            case 'read_file':
                return await readFileTool(String(args.path ?? ''));
            case 'list_directory':
                return await listDirectoryTool(String(args.path ?? '.'));
            case 'search_text':
                return await searchTextTool(String(args.query ?? ''), args.globPattern ? String(args.globPattern) : undefined);
            default:
                return `Error: unknown tool "${name}"`;
        }
    } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
}
