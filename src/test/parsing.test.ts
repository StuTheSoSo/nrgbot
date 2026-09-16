import * as assert from 'assert';
import { extractLeadingToolCallJson, findToolCallJson, stripFences, getCodeBlocks } from '../parsing';

suite('parsing: extractLeadingToolCallJson', () => {
    test('bare JSON tool call followed by prose', () => {
        const input = '{"name":"read_file","arguments":{"path":"a.ts"}} Here is the answer.';
        const r = extractLeadingToolCallJson(input);
        assert.ok(r);
        assert.strictEqual(r!.name, 'read_file');
        assert.strictEqual(r!.arguments, '{"path":"a.ts"}');
        assert.strictEqual(r!.rest, 'Here is the answer.');
    });

    test('leading whitespace is tolerated', () => {
        const r = extractLeadingToolCallJson('   \n {"name":"list_directory","arguments":{}}');
        assert.ok(r);
        assert.strictEqual(r!.name, 'list_directory');
        assert.strictEqual(r!.rest, '');
    });

    test('wrapped in <tool_call> tags', () => {
        const input = '<tool_call>{"name":"read_file","arguments":{"path":"x"}}</tool_call>rest';
        const r = extractLeadingToolCallJson(input);
        assert.ok(r);
        assert.strictEqual(r!.name, 'read_file');
        assert.strictEqual(r!.rest, 'rest');
    });

    test('wrapped in a ```json fence', () => {
        const input = '```json\n{"name":"search_text","arguments":{"query":"foo"}}\n```\nafter';
        const r = extractLeadingToolCallJson(input);
        assert.ok(r);
        assert.strictEqual(r!.name, 'search_text');
        assert.strictEqual(r!.rest, 'after');
    });

    test('arguments as a JSON string are preserved', () => {
        const r = extractLeadingToolCallJson('{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}');
        assert.ok(r);
        assert.strictEqual(r!.arguments, '{"path":"a"}');
    });

    test('nested braces inside string values do not end the object early', () => {
        const input = '{"name":"read_file","arguments":{"path":"a}{b.ts"}}tail';
        const r = extractLeadingToolCallJson(input);
        assert.ok(r);
        assert.strictEqual(r!.arguments, '{"path":"a}{b.ts"}');
        assert.strictEqual(r!.rest, 'tail');
    });

    test('invented / unknown tool name is still parsed (allowlist enforced elsewhere)', () => {
        const r = extractLeadingToolCallJson('{"name":"analyze_code_quality","arguments":{"code":"x"}}');
        assert.ok(r);
        assert.strictEqual(r!.name, 'analyze_code_quality');
    });

    test('plain prose returns null', () => {
        assert.strictEqual(extractLeadingToolCallJson('This is just a normal answer.'), null);
    });

    test('truncated JSON that never closes returns null', () => {
        assert.strictEqual(extractLeadingToolCallJson('{"name":"read_file","arguments":{"path":"a'), null);
    });

    test('object without a string name returns null', () => {
        assert.strictEqual(extractLeadingToolCallJson('{"arguments":{"path":"a"}}'), null);
    });
});

suite('parsing: findToolCallJson', () => {
    test('recovers a tool call embedded after prose', () => {
        const input = 'Sure, let me read it.\n{"name": "read_file", "arguments": {"path": "a/b/c.cs"}}';
        const r = findToolCallJson(input);
        assert.ok(r);
        assert.strictEqual(r!.name, 'read_file');
        assert.strictEqual(r!.arguments, '{"path":"a/b/c.cs"}');
    });

    test('recovers a leading tool call with a long nested path', () => {
        const input = '{"name": "read_file", "arguments": {"path": "Gateway.Libraries/RadioProgrammer/CollinsKY100/ModeSelectionParser.cs"}}';
        const r = findToolCallJson(input);
        assert.ok(r);
        assert.strictEqual(r!.name, 'read_file');
        assert.strictEqual(input.slice(r!.startIdx, r!.endIdx + 1), input);
    });

    test('skips non-tool JSON and returns null when no name is present', () => {
        assert.strictEqual(findToolCallJson('config: {"path": "a", "size": 3}'), null);
    });

    test('plain prose returns null', () => {
        assert.strictEqual(findToolCallJson('Just a normal answer with no JSON.'), null);
    });
});

suite('parsing: stripFences', () => {
    test('strips a simple fenced block', () => {
        assert.strictEqual(stripFences('```\ncode\n```'), 'code');
    });

    test('strips a language tag on the opening fence', () => {
        assert.strictEqual(stripFences('```ts\nconst a = 1;\n```'), 'const a = 1;');
    });

    test('trailing whitespace after the closing fence', () => {
        assert.strictEqual(stripFences('```\ncode\n```\n\n  '), 'code');
    });

    test('duplicated closing fences are all removed', () => {
        assert.strictEqual(stripFences('```\ncode\n```\n```'), 'code');
    });

    test('non-fenced text is returned trimmed and unchanged', () => {
        assert.strictEqual(stripFences('  just text  '), 'just text');
    });

    test('preserves interior blank lines', () => {
        assert.strictEqual(stripFences('```\na\n\nb\n```'), 'a\n\nb');
    });
});

suite('parsing: getCodeBlocks', () => {
    test('returns nothing for prose', () => {
        assert.deepStrictEqual(getCodeBlocks('no code here'), []);
    });

    test('extracts a single block', () => {
        assert.deepStrictEqual(getCodeBlocks('text\n```ts\nconst a = 1;\n```\nmore'), ['const a = 1;']);
    });

    test('extracts multiple blocks in order', () => {
        const input = '```\nfirst\n```\nmid\n```js\nsecond\n```';
        assert.deepStrictEqual(getCodeBlocks(input), ['first', 'second']);
    });
});
