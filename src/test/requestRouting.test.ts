import * as assert from 'assert';
import { determineRequestRouting, RequestRoutingInput } from '../requestRouting';

const defaults: RequestRoutingInput = {
    toolsEnabled: true,
    hasAttachment: false,
    attachmentNeedsWorkspaceLookup: false,
    isFileAction: false,
    hasToolResults: false,
    hasKnowledge: false
};

function route(overrides: Partial<RequestRoutingInput> = {}) {
    return determineRequestRouting({ ...defaults, ...overrides });
}

suite('request routing', () => {
    test('offers tools and injects baseline context for an ordinary grounded question', () => {
        assert.deepStrictEqual(route({ hasKnowledge: true }), {
            offerTools: true,
            fileAction: false,
            injectKnowledge: true
        });
    });

    test('offers tools for an ordinary question without baseline context', () => {
        assert.deepStrictEqual(route(), {
            offerTools: true,
            fileAction: false,
            injectKnowledge: false
        });
    });

    test('keeps the lean file-action route while retaining baseline context', () => {
        assert.deepStrictEqual(route({ isFileAction: true, hasKnowledge: true }), {
            offerTools: true,
            fileAction: true,
            injectKnowledge: true
        });
    });

    test('does not offer tools for a self-contained attachment question', () => {
        assert.deepStrictEqual(route({ hasAttachment: true, hasKnowledge: true }), {
            offerTools: false,
            fileAction: false,
            injectKnowledge: false
        });
    });

    test('offers tools when an attachment asks a cross-file question', () => {
        assert.deepStrictEqual(route({
            hasAttachment: true,
            attachmentNeedsWorkspaceLookup: true,
            hasKnowledge: true
        }), {
            offerTools: true,
            fileAction: false,
            injectKnowledge: false
        });
    });

    test('uses post-tool routing without reinjecting baseline context', () => {
        assert.deepStrictEqual(route({
            hasToolResults: true,
            isFileAction: true,
            hasKnowledge: true
        }), {
            offerTools: true,
            fileAction: false,
            injectKnowledge: false
        });
    });

    test('does not offer tools when workspace tools are disabled', () => {
        assert.deepStrictEqual(route({ toolsEnabled: false, hasKnowledge: true }), {
            offerTools: false,
            fileAction: false,
            injectKnowledge: true
        });
    });
});