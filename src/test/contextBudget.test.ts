import * as assert from 'assert';
import {
    BASELINE_CONTEXT_PREFIX,
    KNOWLEDGE_CONTEXT_HEADING,
    MAP_CONTEXT_HEADING,
    RULES_CONTEXT_PREFIX,
    budgetProjectContext,
    normalizeContextBudget
} from '../contextBudget';

function totalLength(context: { knowledge: string; map: string; rules: string }): number {
    const baseline = context.knowledge || context.map
        ? BASELINE_CONTEXT_PREFIX.length
            + (context.knowledge ? KNOWLEDGE_CONTEXT_HEADING.length + context.knowledge.length : 0)
            + (context.map ? MAP_CONTEXT_HEADING.length + context.map.length : 0)
            + (context.knowledge && context.map ? 2 : 0)
        : 0;
    const rules = context.rules ? RULES_CONTEXT_PREFIX.length + context.rules.length : 0;
    return baseline + rules;
}

suite('combined project-context budget', () => {
    test('keeps the combined context within one cap', () => {
        const result = budgetProjectContext({
            knowledge: ['# Purpose', 'A'.repeat(80), '## Architecture', 'B'.repeat(80)].join('\n\n'),
            map: ['Solution: App.sln', 'Project: App', 'Path: App/App.csproj', 'Kind: executable', 'Project: Core', 'Path: Core/Core.csproj', 'Kind: library'].join('\n'),
            rules: ['# Rules', 'Keep changes focused.', '## Naming', 'Use domain names.'].join('\n\n')
        }, 360, true);

        assert.ok(totalLength(result) <= 360, `${totalLength(result)} exceeds budget`);
        assert.ok(result.knowledge.length > 0);
        assert.ok(result.map.length > 0);
        assert.ok(result.rules.length > 0);
    });

    test('omits rules when they do not apply and redistributes their space', () => {
        const input = {
            knowledge: '# Purpose\n\n' + 'A'.repeat(100),
            map: 'Solution: App.sln\nProject: App\nPath: App/App.csproj',
            rules: '# Rules\n\nNever rename public APIs.'
        };
        const withoutRules = budgetProjectContext(input, 180, false);
        assert.strictEqual(withoutRules.rules, '');
        assert.ok(totalLength(withoutRules) <= 180);
    });

    test('truncates markdown only between complete blocks and names omissions', () => {
        const result = budgetProjectContext({
            knowledge: '# First\n\nFirst paragraph.\n\n## Second\n\n' + 'Second paragraph. '.repeat(8),
            map: '',
            rules: ''
        }, 200, false);

        assert.match(result.knowledge, /^# First/);
        assert.doesNotMatch(result.knowledge, /Second paragraph/);
        assert.match(result.knowledge, /knowledge blocks? omitted/);
    });

    test('truncates maps at complete project records', () => {
        const result = budgetProjectContext({
            knowledge: '',
            map: [
                'Solution: App.sln',
                'Project: Alpha',
                'Path: Alpha/Alpha.csproj',
                'Kind: library',
                'Project: Beta',
                'Path: Beta/Beta.csproj',
                'Kind: executable'
            ].join('\n'),
            rules: ''
        }, 200, false);

        assert.match(result.map, /Solution: App\.sln/);
        assert.match(result.map, /Project: Alpha\nPath: Alpha\/Alpha\.csproj\nKind: library/);
        assert.doesNotMatch(result.map, /Project: Beta/);
        assert.match(result.map, /map record omitted/);
    });

    test('defines zero, negative, NaN, fractional, and tiny budgets', () => {
        assert.strictEqual(normalizeContextBudget(12.9), 12);
        assert.strictEqual(normalizeContextBudget(0), 0);
        assert.strictEqual(normalizeContextBudget(-10), 0);
        assert.strictEqual(normalizeContextBudget(Number.NaN), 0);

        const input = { knowledge: 'important', map: 'map', rules: 'rules' };
        assert.deepStrictEqual(budgetProjectContext(input, 0, true), { knowledge: '', map: '', rules: '' });
        assert.deepStrictEqual(budgetProjectContext(input, -1, true), { knowledge: '', map: '', rules: '' });
        assert.ok(totalLength(budgetProjectContext(input, 5, true)) <= 5);
    });

    test('preserves all content when it fits', () => {
        const input = { knowledge: 'knowledge', map: 'map', rules: 'rules' };
        assert.deepStrictEqual(budgetProjectContext(input, 300, true), input);
    });
});