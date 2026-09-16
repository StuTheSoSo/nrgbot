import * as assert from 'assert';
import { isKnownTool, unknownToolResult, executeTool, TOOLS } from '../tools';

suite('tools: adversarial output handling', () => {
    test('all declared tools are recognized as known', () => {
        for (const tool of TOOLS) {
            assert.strictEqual(isKnownTool(tool.function.name), true, tool.function.name);
        }
    });

    test('invented tool name is not known', () => {
        assert.strictEqual(isKnownTool('analyze_code_quality'), false);
        assert.strictEqual(isKnownTool(''), false);
        assert.strictEqual(isKnownTool('READ_FILE'), false);
    });

    test('unknownToolResult names the tool and instructs against inventing tools', () => {
        const msg = unknownToolResult('analyze_code_quality');
        assert.match(msg, /analyze_code_quality/);
        assert.match(msg, /Do not invent tools/i);
    });

    test('executeTool returns the corrective message for an unknown tool', async () => {
        const result = await executeTool('analyze_code_quality', { code: 'x' });
        assert.strictEqual(result, unknownToolResult('analyze_code_quality'));
    });
});
