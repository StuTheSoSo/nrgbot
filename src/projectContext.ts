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

<!--
Keep this document factual and concise. Prefer concrete names and workspace-relative
paths (for example, src/App/Program.cs). Write "Unknown" when a fact has not been
verified; do not speculate. Replace these comments with project-specific content.
-->

## Purpose and users
<!-- What does this solution do, which problems does it solve, and who operates or depends on it? -->

## Domain glossary
<!-- Define product-specific terms, acronyms, protocols, and names that could be misunderstood. -->

## Architecture
<!-- Summarize the system shape, process boundaries, communication paths, and external systems. -->

## Component responsibilities
<!-- List each major component, what it owns, what it must not own, and its workspace-relative project path. -->

## Key runtime flows
<!-- Describe important flows step by step, naming the components and source paths involved. -->

## Projects and entry points
<!-- List executables, libraries, tests, startup files, and the best workspace-relative paths for reading. -->

## Invariants and constraints
<!-- Record compatibility rules, ordering requirements, safety constraints, and behavior that must remain stable. -->

## Configuration and deployment
<!-- Identify configuration sources, environments, services, artifacts, and deployment locations. Never include secrets. -->

## Build, test, and debug commands
<!-- Give verified commands, required working directories, prerequisites, and useful test filters. -->

## Ownership boundaries
<!-- State team/module ownership, public interfaces, generated code boundaries, and areas requiring coordination. -->

## Conventions
<!-- Record coding standards, architecture patterns, naming rules, and repository-specific practices. -->

## Known hazards
<!-- Note fragile areas, common failure modes, platform assumptions, migrations, and operational gotchas. -->

## Authoritative source paths
<!-- Link each important claim above to workspace-relative code, configuration, tests, or documentation. -->
`;

export interface ProjectEntry {
    name: string;
    /** Project path exactly as written in the .sln (may use backslashes). */
    relPath: string;
}

export type ProjectKind = 'executable' | 'library' | 'test' | 'shared' | 'unknown';

export interface ProjectMetadata {
    language: string;
    targets: string[];
    outputTypes: string[];
    assemblyNames: string[];
    rootNamespaces: string[];
    configurationTypes: string[];
    platformToolsets: string[];
    projectReferences: string[];
    packages: string[];
    additionalDependencies: string[];
    kind: ProjectKind;
}

export interface ProjectDescription extends ProjectEntry, ProjectMetadata {
    path: string;
    entryPoints: string[];
    readable: boolean;
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

function uniqueSorted(values: string[]): string[] {
    return [...new Set(values.map(value => value.trim()).filter(Boolean))]
        .sort((left, right) => left.localeCompare(right));
}

function xmlValues(text: string, tag: string): string[] {
    const expression = new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*([^<]+?)\\s*</${tag}>`, 'gi');
    return uniqueSorted([...text.matchAll(expression)].map(match => match[1]));
}

function xmlIncludes(text: string, tag: string): string[] {
    const expression = new RegExp(`<${tag}\\b[^>]*\\bInclude\\s*=\\s*["']([^"']+)["'][^>]*>`, 'gi');
    return uniqueSorted([...text.matchAll(expression)].map(match => match[1]));
}

function splitValues(values: string[], separator: RegExp): string[] {
    return uniqueSorted(values.flatMap(value => value.split(separator)));
}

function classifyProject(
    relPath: string,
    outputTypes: string[],
    configurationTypes: string[],
    isTestProject: boolean
): ProjectKind {
    if (relPath.toLowerCase().endsWith('.shproj')) {
        return 'shared';
    }
    if (isTestProject) {
        return 'test';
    }
    const types = [...outputTypes, ...configurationTypes].map(value => value.toLowerCase());
    if (types.some(value => ['exe', 'winexe', 'appcontainerexe', 'application'].includes(value))) {
        return 'executable';
    }
    if (types.some(value => ['library', 'dynamiclibrary', 'staticlibrary'].includes(value))) {
        return 'library';
    }
    return 'unknown';
}

/** Extract typed, deduplicated metadata from a .NET or C++ project file. */
export function parseProjectMetadata(projText: string, relPath: string): ProjectMetadata {
    const ext = relPath.toLowerCase().split('.').pop();
    const targets = splitValues([
        ...xmlValues(projText, 'TargetFramework'),
        ...xmlValues(projText, 'TargetFrameworks'),
        ...xmlValues(projText, 'TargetFrameworkVersion')
    ], /;/);
    const outputTypes = xmlValues(projText, 'OutputType');
    const configurationTypes = xmlValues(projText, 'ConfigurationType');
    const packages = xmlIncludes(projText, 'PackageReference');
    const isTestProject = xmlValues(projText, 'IsTestProject')
        .some(value => value.toLowerCase() === 'true')
        || packages.some(value => /(?:^|\.)test(?:sdk|ing)?(?:\.|$)|(?:xunit|nunit|mstest)/i.test(value));

    return {
        language: languageFromExt(relPath),
        targets,
        outputTypes,
        assemblyNames: xmlValues(projText, 'AssemblyName'),
        rootNamespaces: xmlValues(projText, 'RootNamespace'),
        configurationTypes,
        platformToolsets: xmlValues(projText, 'PlatformToolset'),
        projectReferences: xmlIncludes(projText, 'ProjectReference'),
        packages,
        additionalDependencies: ext === 'vcxproj'
            ? splitValues(xmlValues(projText, 'AdditionalDependencies'), /;/)
                .filter(value => !value.startsWith('%('))
            : [],
        kind: classifyProject(relPath, outputTypes, configurationTypes, isTestProject)
    };
}

/** Pull a short list of facts (framework/output or config/toolset) from a project file. */
export function extractProjectFacts(projText: string, relPath: string): string[] {
    const metadata = parseProjectMetadata(projText, relPath);
    return relPath.toLowerCase().endsWith('.vcxproj')
        ? [...metadata.configurationTypes, ...metadata.platformToolsets]
        : [...metadata.targets, ...metadata.outputTypes];
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

export interface WorkspaceInventory {
    files: string[];
    directories: string[];
    packageJson: Record<string, string>;
    truncated: boolean;
}

const FALLBACK_MAX_DEPTH = 4;
const FALLBACK_MAX_ENTRIES = 1500;
const FALLBACK_MAX_PACKAGE_BYTES = 256_000;
const EXCLUDED_DISCOVERY_DIRS = new Set([
    '.git', '.vs', '.vscode-test', 'bin', 'build', 'coverage', 'dist', 'node_modules',
    'obj', 'out', 'packages', 'target'
]);
const SOURCE_ROOT_NAMES = new Set(['app', 'apps', 'lib', 'libs', 'source', 'src']);
const TEST_ROOT_NAMES = new Set(['spec', 'specs', 'test', 'tests']);
const FALLBACK_ENTRY_NAMES = new Set([
    'app.ts', 'app.tsx', 'index.js', 'index.ts', 'index.tsx', 'main.c', 'main.cpp',
    'main.js', 'main.py', 'main.ts', 'main.tsx', 'program.cs'
]);
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
    c: 'C', cc: 'C++', cpp: 'C++', cs: 'C#', cxx: 'C++', fs: 'F#',
    go: 'Go', java: 'Java', js: 'JavaScript', jsx: 'JavaScript', py: 'Python',
    rs: 'Rust', ts: 'TypeScript', tsx: 'TypeScript', vb: 'VB'
};

function pathSegments(value: string): string[] {
    return value.replace(/\\/g, '/').split('/').filter(Boolean);
}

function isExcludedDiscoveryPath(value: string): boolean {
    return pathSegments(value).some(segment => EXCLUDED_DISCOVERY_DIRS.has(segment.toLowerCase()));
}

function isManifestOrBuildFile(value: string): boolean {
    const name = pathSegments(value).pop()?.toLowerCase() ?? '';
    return name === 'package.json'
        || name.endsWith('.code-workspace')
        || name === 'cmakelists.txt'
        || name === 'directory.build.props'
        || name === 'directory.build.targets'
        || name === 'global.json'
        || name === 'pyproject.toml'
        || name === 'cargo.toml'
        || /^readme(?:\.[^.]+)?$/i.test(name);
}

function namedRoots(directories: string[], names: Set<string>): string[] {
    return uniqueSorted(directories.filter(directory => {
        const name = pathSegments(directory).pop()?.toLowerCase() ?? '';
        return names.has(name);
    }));
}

function packageScripts(packageJson: Record<string, string>): string[] {
    const lines: string[] = [];
    for (const path of Object.keys(packageJson).sort((left, right) => left.localeCompare(right))) {
        try {
            const parsed = JSON.parse(packageJson[path]) as { scripts?: unknown };
            if (!parsed.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) {
                continue;
            }
            const scripts = Object.keys(parsed.scripts).sort((left, right) => left.localeCompare(right));
            if (scripts.length) {
                lines.push(`${path}: ${scripts.join(', ')}`);
            }
        } catch {
            lines.push(`${path}: unreadable JSON`);
        }
    }
    return lines;
}

/** Render a deterministic summary for a bounded workspace inventory with no solution. */
export function renderWorkspaceOverview(inventory: WorkspaceInventory): string {
    const files = uniqueSorted(inventory.files.filter(path => !isExcludedDiscoveryPath(path)));
    const directories = uniqueSorted(inventory.directories.filter(path => !isExcludedDiscoveryPath(path)));
    const manifests = files.filter(isManifestOrBuildFile);
    const sourceRoots = namedRoots(directories, SOURCE_ROOT_NAMES);
    const testRoots = namedRoots(directories, TEST_ROOT_NAMES);
    const entryPoints = files.filter(path => FALLBACK_ENTRY_NAMES.has(
        pathSegments(path).pop()?.toLowerCase() ?? ''
    ));
    const languageCounts = new Map<string, number>();
    for (const file of files) {
        const name = pathSegments(file).pop() ?? '';
        const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
        const language = LANGUAGE_BY_EXTENSION[extension];
        if (language) {
            languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
        }
    }
    const languages = [...languageCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([language, count]) => `${language} (${count})`);
    const scripts = packageScripts(Object.fromEntries(
        Object.entries(inventory.packageJson).filter(([path]) => !isExcludedDiscoveryPath(path))
    ));

    const lines = ['No .sln found. Bounded workspace discovery:'];
    if (manifests.length) {
        lines.push(`Manifests/build files: ${manifests.join(', ')}`);
    }
    if (sourceRoots.length) {
        lines.push(`Source roots: ${sourceRoots.join(', ')}`);
    }
    if (testRoots.length) {
        lines.push(`Test roots: ${testRoots.join(', ')}`);
    }
    if (languages.length) {
        lines.push(`Languages: ${languages.join(', ')}`);
    }
    if (entryPoints.length) {
        lines.push(`Probable entry points: ${entryPoints.join(', ')}`);
    }
    if (scripts.length) {
        lines.push('Package scripts:', ...scripts.map(script => `- ${script}`));
    }
    if (files.length === 0 && directories.length === 0) {
        lines.push('Workspace is empty or unreadable.');
    }
    if (inventory.truncated) {
        lines.push(`Discovery stopped after ${FALLBACK_MAX_ENTRIES} entries.`);
    }
    return lines.join('\n');
}

async function inventoryWorkspace(root: vscode.Uri): Promise<WorkspaceInventory> {
    const queue: { uri: vscode.Uri; rel: string; depth: number }[] = [{ uri: root, rel: '', depth: 0 }];
    const files: string[] = [];
    const directories: string[] = [];
    const packageJson: Record<string, string> = {};
    let scanned = 0;

    while (queue.length > 0 && scanned < FALLBACK_MAX_ENTRIES) {
        const current = queue.shift();
        if (!current) {
            break;
        }
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(current.uri);
        } catch {
            continue;
        }
        entries.sort(([left], [right]) => left.localeCompare(right));
        for (const [name, type] of entries) {
            scanned++;
            const rel = current.rel ? `${current.rel}/${name}` : name;
            if (type === vscode.FileType.Directory) {
                if (!EXCLUDED_DISCOVERY_DIRS.has(name.toLowerCase())) {
                    directories.push(rel);
                    if (current.depth < FALLBACK_MAX_DEPTH) {
                        queue.push({ uri: vscode.Uri.joinPath(current.uri, name), rel, depth: current.depth + 1 });
                    }
                }
            } else {
                files.push(rel);
                if (name.toLowerCase() === 'package.json') {
                    const uri = vscode.Uri.joinPath(current.uri, name);
                    try {
                        const stat = await vscode.workspace.fs.stat(uri);
                        if (stat.size <= FALLBACK_MAX_PACKAGE_BYTES) {
                            const content = await readText(uri);
                            if (content !== undefined) {
                                packageJson[rel] = content;
                            }
                        }
                    } catch {
                        // Keep the manifest path even when its scripts cannot be read.
                    }
                }
            }
            if (scanned >= FALLBACK_MAX_ENTRIES) {
                break;
            }
        }
    }

    return { files, directories, packageJson, truncated: queue.length > 0 };
}

async function overviewWithoutSolution(root: vscode.Uri): Promise<string> {
    return renderWorkspaceOverview(await inventoryWorkspace(root));
}

function normalizedPath(value: string): string {
    const parts: string[] = [];
    for (const part of value.replace(/\\/g, '/').split('/')) {
        if (!part || part === '.') {
            continue;
        }
        if (part === '..') {
            parts.pop();
        } else {
            parts.push(part);
        }
    }
    return parts.join('/').toLowerCase();
}

function resolveReferencePath(projectPath: string, reference: string): string {
    const slash = projectPath.replace(/\\/g, '/').lastIndexOf('/');
    const folder = slash >= 0 ? projectPath.slice(0, slash + 1) : '';
    return normalizedPath(folder + reference);
}

const ENTRY_POINT_NAMES = new Set([
    'program.cs', 'app.xaml', 'application.xaml', 'main.cpp', 'main.c', 'winmain.cpp'
]);
const MAX_ENTRY_SCAN_DEPTH = 3;
const MAX_ENTRY_SCAN_ENTRIES = 500;
const MAX_ENTRY_POINTS = 8;
const MAX_ENTRY_SOURCE_READS = 100;
const MAX_ENTRY_SOURCE_BYTES = 256_000;

/** Identify conventional entry-point filenames or C/C++ source containing an entry function. */
export function isProbableEntryPoint(fileName: string, content?: string): boolean {
    if (ENTRY_POINT_NAMES.has(fileName.toLowerCase())) {
        return true;
    }
    if (!/\.(?:c|cc|cpp|cxx)$/i.test(fileName) || content === undefined) {
        return false;
    }
    return /\b(?:main|wWinMain|WinMain)\s*\(/.test(content);
}

async function findProbableEntryPoints(projectUri: vscode.Uri): Promise<string[]> {
    const projectDir = vscode.Uri.joinPath(projectUri, '..');
    const queue: { uri: vscode.Uri; rel: string; depth: number }[] = [{ uri: projectDir, rel: '', depth: 0 }];
    const found: string[] = [];
    let scanned = 0;
    let sourceReads = 0;

    while (queue.length > 0 && scanned < MAX_ENTRY_SCAN_ENTRIES && found.length < MAX_ENTRY_POINTS) {
        const current = queue.shift();
        if (!current) {
            break;
        }
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(current.uri);
        } catch {
            continue;
        }
        entries.sort(([left], [right]) => left.localeCompare(right));
        for (const [name, type] of entries) {
            scanned++;
            const rel = current.rel ? `${current.rel}/${name}` : name;
            if (type === vscode.FileType.Directory) {
                if (current.depth < MAX_ENTRY_SCAN_DEPTH && !/^(bin|obj|packages|node_modules|\.git)$/i.test(name)) {
                    queue.push({ uri: vscode.Uri.joinPath(current.uri, name), rel, depth: current.depth + 1 });
                }
            } else if (isProbableEntryPoint(name)) {
                found.push(rel);
            } else if (/\.(?:c|cc|cpp|cxx)$/i.test(name) && sourceReads < MAX_ENTRY_SOURCE_READS) {
                sourceReads++;
                const sourceUri = vscode.Uri.joinPath(current.uri, name);
                try {
                    const stat = await vscode.workspace.fs.stat(sourceUri);
                    if (stat.size <= MAX_ENTRY_SOURCE_BYTES) {
                        const content = await readText(sourceUri);
                        if (content !== undefined && isProbableEntryPoint(name, content)) {
                            found.push(rel);
                        }
                    }
                } catch {
                    // Ignore source files that disappear or become unreadable during discovery.
                }
            }
            if (scanned >= MAX_ENTRY_SCAN_ENTRIES || found.length >= MAX_ENTRY_POINTS) {
                break;
            }
        }
    }
    return uniqueSorted(found);
}

function renderList(label: string, values: string[]): string | undefined {
    return values.length ? `${label}: ${values.join(', ')}` : undefined;
}

/** Render typed projects and their resolved dependency edges in deterministic order. */
export function renderSolutionMap(solutionName: string, projects: ProjectDescription[]): string {
    const sorted = [...projects].sort((left, right) => left.name.localeCompare(right.name));
    const namesByPath = new Map(sorted.map(project => [normalizedPath(project.relPath), project.name]));
    const lines = [`Solution: ${solutionName} (${sorted.length} project${sorted.length === 1 ? '' : 's'})`];
    const edges: string[] = [];

    for (const project of sorted) {
        lines.push(`Project: ${project.name}`);
        lines.push(`Path: ${project.path}`);
        lines.push(`Language: ${project.language}`);
        lines.push(`Kind: ${project.kind}`);
        if (!project.readable) {
            lines.push('Status: project file unreadable');
            continue;
        }
        const references = uniqueSorted(project.projectReferences.map(reference => {
            const resolved = namesByPath.get(resolveReferencePath(project.relPath, reference));
            const display = resolved ?? reference.replace(/\\/g, '/');
            edges.push(`${project.name} -> ${display}`);
            return display;
        }));
        const details = [
            renderList('Targets', project.targets),
            renderList('Output types', project.outputTypes),
            renderList('Configuration types', project.configurationTypes),
            renderList('Assembly names', project.assemblyNames),
            renderList('Root namespaces', project.rootNamespaces),
            renderList('Platform toolsets', project.platformToolsets),
            renderList('References', references),
            renderList('Packages', project.packages),
            renderList('Native dependencies', project.additionalDependencies),
            renderList('Probable entry points', project.entryPoints)
        ].filter((line): line is string => !!line);
        lines.push(...details);
    }

    const uniqueEdges = uniqueSorted(edges);
    if (uniqueEdges.length) {
        lines.push('Dependency edges:', ...uniqueEdges);
    }
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
    const descriptions: ProjectDescription[] = [];
    for (const p of projects) {
        const segments = p.relPath.replace(/\\/g, '/').split('/');
        const projUri = vscode.Uri.joinPath(slnDir, ...segments);
        const projText = await readText(projUri);
        const metadata = parseProjectMetadata(projText ?? '', p.relPath);
        descriptions.push({
            ...p,
            ...metadata,
            path: vscode.workspace.asRelativePath(projUri),
            entryPoints: projText ? await findProbableEntryPoints(projUri) : [],
            readable: projText !== undefined
        });
    }
    return renderSolutionMap(slnName, descriptions);
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
    for (const sln of [...slnFiles].sort((left, right) => left.path.localeCompare(right.path))) {
        parts.push(await describeSolution(sln));
    }
    return applyBudget(parts.join('\n\n'), maxChars);
}
