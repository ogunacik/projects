export interface ParsedSearchQuery {
  filters: Array<{ field: string; value: string }>;
  terms: string[];
}

const RESERVED_WORDS = new Set(['and']);

export function tokenizeSearchQuery(query: string): string[] {
  const tokens: string[] = [];
  const tokenPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(query)) !== null) {
    const quoted = match[1] ?? match[2];
    const rawToken = quoted ?? match[3] ?? '';
    const token = rawToken.replace(/\\(["'])/g, '$1').trim();
    if (token) tokens.push(token);
  }

  return tokens;
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
  const parsed: ParsedSearchQuery = { filters: [], terms: [] };

  tokenizeSearchQuery(query).forEach((token) => {
    if (RESERVED_WORDS.has(token.toLowerCase())) return;

    const separatorIndex = token.indexOf(':');
    if (separatorIndex > 0 && separatorIndex < token.length - 1) {
      const field = token.slice(0, separatorIndex).trim();
      const value = token.slice(separatorIndex + 1).trim();

      if (/^[A-Za-z_][\w.-]*$/.test(field) && value) {
        parsed.filters.push({ field, value });
        return;
      }
    }

    parsed.terms.push(token);
  });

  return parsed;
}

export function getSearchHighlightTerms(query: string): string[] {
  const parsed = parseSearchQuery(query);
  const deduped = new Map<string, string>();

  [...parsed.terms, ...parsed.filters.map((filter) => filter.value)].forEach((term) => {
    const normalized = term.trim();
    if (!normalized) return;
    deduped.set(normalized.toLowerCase(), normalized);
  });

  return Array.from(deduped.values()).sort((a, b) => b.length - a.length);
}
