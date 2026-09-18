export interface RequestRoutingInput {
    toolsEnabled: boolean;
    hasAttachment: boolean;
    attachmentNeedsWorkspaceLookup: boolean;
    isFileAction: boolean;
    hasToolResults: boolean;
    hasKnowledge: boolean;
}

export interface RequestRouting {
    offerTools: boolean;
    fileAction: boolean;
    injectKnowledge: boolean;
}

/** Decide which request capabilities and context apply to the current turn. */
export function determineRequestRouting(input: RequestRoutingInput): RequestRouting {
    const offerTools = input.hasAttachment
        ? input.toolsEnabled && input.attachmentNeedsWorkspaceLookup
        : input.toolsEnabled;
    const fileAction = offerTools
        && !input.hasAttachment
        && input.isFileAction
        && !input.hasToolResults;
    const injectKnowledge = input.hasKnowledge
        && (!input.hasAttachment || input.attachmentNeedsWorkspaceLookup);

    return { offerTools, fileAction, injectKnowledge };
}