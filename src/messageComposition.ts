import {
    BASELINE_CONTEXT_PREFIX,
    KNOWLEDGE_CONTEXT_HEADING,
    MAP_CONTEXT_HEADING
} from './contextBudget';

export interface ChatMessage {
    role: string;
    content: string | null;
    tool_calls?: unknown[];
    tool_call_id?: string;
}

export interface BaselineContext {
    knowledge: string;
    map: string;
}

/** Build one neutral reference message without inventing an assistant acknowledgement. */
export function buildBaselineContextMessage(context: BaselineContext): ChatMessage | undefined {
    const sections: string[] = [];
    if (context.knowledge) {
        sections.push(KNOWLEDGE_CONTEXT_HEADING + context.knowledge);
    }
    if (context.map) {
        sections.push(MAP_CONTEXT_HEADING + context.map);
    }
    if (sections.length === 0) {
        return undefined;
    }

    return {
        role: 'user',
        content: BASELINE_CONTEXT_PREFIX + sections.join('\n\n')
    };
}

/** Insert baseline context immediately before the latest user turn. */
export function composeRequestMessages(
    systemMessage: ChatMessage,
    conversation: ChatMessage[],
    contextMessage?: ChatMessage
): ChatMessage[] {
    if (!contextMessage) {
        return [systemMessage, ...conversation];
    }

    let latestUserIndex = -1;
    for (let index = conversation.length - 1; index >= 0; index--) {
        if (conversation[index].role === 'user') {
            latestUserIndex = index;
            break;
        }
    }

    if (latestUserIndex < 0) {
        return [systemMessage, ...conversation, contextMessage];
    }

    return [
        systemMessage,
        ...conversation.slice(0, latestUserIndex),
        contextMessage,
        ...conversation.slice(latestUserIndex)
    ];
}