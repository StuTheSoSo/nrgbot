import * as assert from 'assert';
import {
    ATTACHMENT_SYSTEM_PROMPT,
    FILE_ACTION_SYSTEM_PROMPT,
    GROUNDING_PREAMBLE,
    missingAccessReminder,
    POST_TOOL_SYSTEM_PROMPT
} from '../grounding';

suite('provenance-aware grounding prompts', () => {
    test('labels curated guidance and generated observations by provenance', () => {
        assert.match(GROUNDING_PREAMBLE, /Curated project knowledge/);
        assert.match(GROUNDING_PREAMBLE, /maintainer-authored guidance/);
        assert.match(GROUNDING_PREAMBLE, /Generated solution observations/);
        assert.match(GROUNDING_PREAMBLE, /automatically observed project metadata/);
    });

    test('gives current inspected source authority over implementation details', () => {
        assert.match(GROUNDING_PREAMBLE, /Current workspace source.*authoritative for implementation details/);
        assert.match(POST_TOOL_SYSTEM_PROMPT, /Current source.*authoritative for implementation details/);
    });

    test('requires conflict reporting with workspace-relative path evidence', () => {
        assert.match(GROUNDING_PREAMBLE, /describe the conflict explicitly/);
        assert.match(GROUNDING_PREAMBLE, /cite the relevant workspace-relative paths/);
        assert.match(POST_TOOL_SYSTEM_PROMPT, /conflict.*curated project knowledge.*generated solution observations/i);
        assert.match(FILE_ACTION_SYSTEM_PROMPT, /cite relevant workspace-relative paths/);
    });

    test('uses bounded lookup when evidence is absent and states limitations without tools', () => {
        assert.match(GROUNDING_PREAMBLE, /inspect only the smallest relevant set of files/);
        assert.match(GROUNDING_PREAMBLE, /If tools are unavailable, state what the supplied context does not establish/);
        assert.match(GROUNDING_PREAMBLE, /Never guess or invent project-specific facts/);
    });

    test('contains no hard-coded product or technology claims', () => {
        const prompts = [GROUNDING_PREAMBLE, ATTACHMENT_SYSTEM_PROMPT, FILE_ACTION_SYSTEM_PROMPT, POST_TOOL_SYSTEM_PROMPT].join('\n');
        assert.doesNotMatch(prompts, /Starfish|radio-gateway|\.NET\/C\+\+|Unity|React/i);
    });

    test('keeps self-contained attachment requests focused on supplied code', () => {
        assert.match(ATTACHMENT_SYSTEM_PROMPT, /complete source to analyze/);
        assert.match(ATTACHMENT_SYSTEM_PROMPT, /review, grading, or quality request/);
        assert.match(ATTACHMENT_SYSTEM_PROMPT, /Do not reproduce the complete attachment/);
        assert.doesNotMatch(ATTACHMENT_SYSTEM_PROMPT, /\btools?\b|file system/i);
    });

    test('recovers attachment access refusals without requesting tools', () => {
        const attachmentReminder = missingAccessReminder(true);
        assert.match(attachmentReminder, /source file is already included/);
        assert.match(attachmentReminder, /Analyze that supplied code directly/);
        assert.match(attachmentReminder, /Do not discuss tools or file access/);

        assert.match(missingAccessReminder(false), /Use the supplied read-only tools/);
    });
});