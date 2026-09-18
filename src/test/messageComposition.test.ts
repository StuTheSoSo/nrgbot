import * as assert from 'assert';
import {
    buildBaselineContextMessage,
    ChatMessage,
    composeRequestMessages
} from '../messageComposition';

const system: ChatMessage = { role: 'system', content: 'system' };
const context = buildBaselineContextMessage({ knowledge: 'Purpose', map: 'Solution: App.sln' });

suite('message composition', () => {
    test('builds one neutral context message with both sections', () => {
        assert.ok(context);
        assert.strictEqual(context.role, 'user');
        assert.match(context.content ?? '', /## Curated project knowledge\nPurpose/);
        assert.match(context.content ?? '', /## Generated solution observations\nSolution: App\.sln/);
        assert.doesNotMatch(context.content ?? '', /Understood|I will answer/);
    });

    test('returns no context message when both sections are empty', () => {
        assert.strictEqual(buildBaselineContextMessage({ knowledge: '', map: '' }), undefined);
    });

    test('places context immediately before the latest user question', () => {
        const conversation: ChatMessage[] = [
            { role: 'user', content: 'Earlier question' },
            { role: 'assistant', content: 'Earlier answer' },
            { role: 'user', content: 'Current question' }
        ];

        assert.deepStrictEqual(composeRequestMessages(system, conversation, context), [
            system,
            conversation[0],
            conversation[1],
            context,
            conversation[2]
        ]);
    });

    test('appends context after history when there is no user message', () => {
        const conversation: ChatMessage[] = [{ role: 'assistant', content: 'Ready' }];
        assert.deepStrictEqual(composeRequestMessages(system, conversation, context), [
            system,
            conversation[0],
            context
        ]);
    });

    test('does not alter assistant tool-call and tool-result ordering', () => {
        const conversation: ChatMessage[] = [
            { role: 'user', content: 'Inspect it' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'call-1' }] },
            { role: 'tool', content: 'result', tool_call_id: 'call-1' }
        ];

        assert.deepStrictEqual(composeRequestMessages(system, conversation), [system, ...conversation]);
    });

    test('leaves an attached question unchanged when context injection is disabled', () => {
        const conversation: ChatMessage[] = [
            { role: 'user', content: 'Review this\nAttached file: src/app.ts' }
        ];
        assert.deepStrictEqual(composeRequestMessages(system, conversation), [system, ...conversation]);
    });
});