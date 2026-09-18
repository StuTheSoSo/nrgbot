export interface ProjectContextSections {
    knowledge: string;
    map: string;
    rules: string;
}

export const BASELINE_CONTEXT_PREFIX = 'Project context reference for the current question:\n\n';
export const KNOWLEDGE_CONTEXT_HEADING = '## Curated project knowledge\n';
export const MAP_CONTEXT_HEADING = '## Generated solution observations\n';
export const RULES_CONTEXT_PREFIX = '\n\nWhen you write or change any code, you MUST follow these project refactoring rules:\n\n';

interface TruncationResult {
    text: string;
    omitted: number;
}

interface BudgetSection {
    key: keyof ProjectContextSections;
    source: string;
    weight: number;
    unit: string;
    split: (text: string) => string[];
    cap: number;
    result: TruncationResult;
}

function markdownBlocks(text: string): string[] {
    return text.trim().split(/\n\s*\n/).map(block => block.trim()).filter(Boolean);
}

function mapRecords(text: string): string[] {
    const records: string[] = [];
    let current: string[] = [];
    let dependencyMode = false;

    const flush = () => {
        if (current.length) {
            records.push(current.join('\n'));
            current = [];
        }
    };

    for (const line of text.trim().split('\n')) {
        if (line.startsWith('Project: ')) {
            flush();
            dependencyMode = false;
            current.push(line);
        } else if (line === 'Dependency edges:') {
            flush();
            dependencyMode = true;
            records.push(line);
        } else if (dependencyMode) {
            records.push(line);
        } else {
            current.push(line);
        }
    }
    flush();
    return records.filter(Boolean);
}

function truncateUnits(text: string, maxChars: number, unit: string, split: (value: string) => string[]): TruncationResult {
    if (!text || maxChars <= 0) {
        return { text: '', omitted: text ? split(text).length : 0 };
    }
    if (text.length <= maxChars) {
        return { text, omitted: 0 };
    }

    const units = split(text);
    for (let kept = units.length - 1; kept >= 0; kept--) {
        const omitted = units.length - kept;
        const notice = `... [${omitted} ${unit}${omitted === 1 ? '' : 's'} omitted]`;
        const prefix = units.slice(0, kept).join('\n\n');
        const candidate = prefix ? `${prefix}\n\n${notice}` : notice;
        if (candidate.length <= maxChars) {
            return { text: candidate, omitted };
        }
    }
    return { text: '', omitted: units.length };
}

/** Convert invalid, negative, or fractional configuration values into a strict cap. */
export function normalizeContextBudget(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Fit knowledge, map, and request-applicable rules into one combined character cap.
 * Curated knowledge can borrow map capacity; applicable rules retain their allocation.
 */
export function budgetProjectContext(
    context: ProjectContextSections,
    maxChars: number,
    includeRules: boolean
): ProjectContextSections {
    const totalBudget = normalizeContextBudget(maxChars);
    if (totalBudget === 0) {
        return { knowledge: '', map: '', rules: '' };
    }

    const hasKnowledge = context.knowledge.trim().length > 0;
    const hasMap = context.map.trim().length > 0;
    const hasRules = includeRules && context.rules.trim().length > 0;
    const baselineOverhead = hasKnowledge || hasMap
        ? BASELINE_CONTEXT_PREFIX.length
            + (hasKnowledge ? KNOWLEDGE_CONTEXT_HEADING.length : 0)
            + (hasMap ? MAP_CONTEXT_HEADING.length : 0)
            + (hasKnowledge && hasMap ? 2 : 0)
        : 0;
    const rulesOverhead = hasRules ? RULES_CONTEXT_PREFIX.length : 0;
    const budget = Math.max(0, totalBudget - baselineOverhead - rulesOverhead);
    if (budget === 0) {
        return { knowledge: '', map: '', rules: '' };
    }

    const allSections: BudgetSection[] = [
        {
            key: 'knowledge', source: context.knowledge.trim(), weight: 0.45,
            unit: 'knowledge block', split: markdownBlocks, cap: 0, result: { text: '', omitted: 0 }
        },
        {
            key: 'map', source: context.map.trim(), weight: 0.35,
            unit: 'map record', split: mapRecords, cap: 0, result: { text: '', omitted: 0 }
        },
        {
            key: 'rules', source: hasRules ? context.rules.trim() : '', weight: 0.2,
            unit: 'rules block', split: markdownBlocks, cap: 0, result: { text: '', omitted: 0 }
        }
    ];
    const sections = allSections.filter(section => section.source.length > 0);

    if (sections.length === 0) {
        return { knowledge: '', map: '', rules: '' };
    }

    const totalWeight = sections.reduce((sum, section) => sum + section.weight, 0);
    let assigned = 0;
    sections.forEach((section, index) => {
        section.cap = index === sections.length - 1
            ? budget - assigned
            : Math.floor(budget * section.weight / totalWeight);
        assigned += section.cap;
        section.result = truncateUnits(section.source, section.cap, section.unit, section.split);
    });

    const knowledgeSection = sections.find(section => section.key === 'knowledge');
    const mapSection = sections.find(section => section.key === 'map');
    if (knowledgeSection && mapSection && knowledgeSection.source.length > knowledgeSection.cap) {
        const transfer = Math.min(
            knowledgeSection.source.length - knowledgeSection.cap,
            Math.max(0, mapSection.cap - 256)
        );
        knowledgeSection.cap += transfer;
        mapSection.cap -= transfer;
        for (const section of [knowledgeSection, mapSection]) {
            section.result = truncateUnits(section.source, section.cap, section.unit, section.split);
        }
    }

    let remaining = budget - sections.reduce((sum, section) => sum + section.result.text.length, 0);
    for (const section of sections) {
        if (remaining <= 0 || section.result.omitted === 0) {
            continue;
        }
        const previousLength = section.result.text.length;
        const expanded = truncateUnits(section.source, previousLength + remaining, section.unit, section.split);
        section.result = expanded;
        section.cap += expanded.text.length - previousLength;
        remaining -= expanded.text.length - previousLength;
    }

    const output: ProjectContextSections = { knowledge: '', map: '', rules: '' };
    for (const section of sections) {
        output[section.key] = section.result.text;
    }
    return output;
}