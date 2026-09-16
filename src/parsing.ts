// Pure, dependency-free parsers for model output. Kept free of the `vscode` module so they
// can be unit-tested directly. `stripFences` and `getCodeBlocks` mirror the copies in
// media/webview.js (which cannot import this module, as it runs as a plain browser script).

export interface LeadingToolCall {
    name: string;
    arguments: string;
    rest: string;
}

/**
 * Looks for a tool call a model wrote as plain JSON text at the start of its content (optionally
 * wrapped in <tool_call> tags or a ```json fence), instead of using the proper tool_calls delta.
 * Returns the parsed call plus whatever text follows it, so leaked/echoed JSON can be stripped
 * even when real prose follows.
 */
export function extractLeadingToolCallJson(content: string): LeadingToolCall | null {
    let rest = content.replace(/^\s+/, '');
    const tagMatch = rest.match(/^<tool_call>\s*/i);
    if (tagMatch) rest = rest.slice(tagMatch[0].length);
    const fenceMatch = rest.match(/^```(?:json)?\s*/i);
    if (fenceMatch) rest = rest.slice(fenceMatch[0].length);
    if (!rest.startsWith('{')) return null;

    let depth = 0;
    let inString = false;
    let escape = false;
    let endIdx = -1;
    for (let i = 0; i < rest.length; i++) {
        const ch = rest[i];
        if (inString) {
            if (escape) escape = false;
            else if (ch === '\\') escape = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) { endIdx = i; break; }
        }
    }
    if (endIdx === -1) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(rest.slice(0, endIdx + 1));
    } catch {
        return null;
    }

    const name = (parsed as { name?: unknown })?.name;
    const args = (parsed as { arguments?: unknown })?.arguments;
    if (typeof name !== 'string') return null;

    let remainder = rest.slice(endIdx + 1);
    remainder = remainder.replace(/^\s*<\/tool_call>/i, '');
    remainder = remainder.replace(/^\s*```/, '');
    remainder = remainder.replace(/^\s+/, '');

    return {
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        rest: remainder
    };
}

/**
 * Removes a single wrapping code fence from a response, tolerating a language tag on the opening
 * fence and any number of trailing blank lines or duplicated closing fences. Returns the trimmed
 * text unchanged when it does not start with a fence.
 */
export function stripFences(raw: string): string {
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

/** Returns the contents of every fenced code block in the response, in order. */
export function getCodeBlocks(raw: string): string[] {
    const blocks: string[] = [];
    raw.replace(/```[^\n]*\n([\s\S]*?)```/g, (match, code: string) => {
        blocks.push(code.replace(/\n$/, ''));
        return match;
    });
    return blocks;
}
