export type QueryNode =
  | { readonly kind: "term"; readonly term: string }
  | { readonly kind: "not"; readonly child: QueryNode }
  | { readonly kind: "and"; readonly children: readonly QueryNode[] }
  | { readonly kind: "or"; readonly children: readonly QueryNode[] };

export type ParsedQuery = {
  readonly raw: string;
  readonly tree: QueryNode;
  readonly terms: readonly string[];
  readonly excluded: readonly string[];
};

export type QueryParseResult =
  | { readonly ok: true; readonly query: ParsedQuery }
  | { readonly ok: false; readonly error: string };

export type QueryEvaluation = {
  readonly hit: boolean;
  readonly absent: readonly string[];
  readonly excludedPresent: readonly string[];
};

const QUOTE_MAP: Readonly<Record<string, string>> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201C": '"',
  "\u201D": '"',
  "\u00A0": " ",
};

export function normalise(text: string): string {
  const nfkc = text.normalize("NFKC");
  const folded = nfkc.replace(
    /[\u2018\u2019\u201C\u201D\u00A0]/g,
    (ch) => QUOTE_MAP[ch] ?? ch,
  );
  const joined = folded.replace(/(\w)-[ \t]*\r?\n\s*(\w)/g, "$1-$2");
  return joined.replace(/\s+/g, " ").trim();
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function termPattern(term: string): RegExp {
  const prefix = term.endsWith("*");
  const stripped = term.replace(/\*+$/, "").trim();
  const words = stripped.split(/[\s-]+/).filter((word) => word.length > 0);
  const body = words.map(escapeRegex).join("[\\s-]+");
  const tail = prefix ? "[a-z0-9]*" : "(?![a-z0-9])";
  return new RegExp(`(?<![a-z0-9])${body}${tail}`, "i");
}

export function hasTerm(normalisedText: string, term: string): boolean {
  if (term.replace(/\*+$/, "").trim().length === 0) return false;
  return termPattern(term).test(normalisedText);
}

function tokenizeQuery(query: string): readonly string[] {
  const matches = query.match(/\(|\)|"[^"]*"|[^\s()"]+/g) ?? [];
  return matches.map((token) =>
    token.startsWith('"') && token.endsWith('"') && token.length >= 2
      ? token.slice(1, -1)
      : token,
  );
}

type ParserState = {
  readonly tokens: readonly string[];
  pos: number;
  negated: number;
  readonly terms: string[];
  readonly excluded: string[];
};

function peekToken(state: ParserState): string | undefined {
  return state.pos < state.tokens.length ? state.tokens[state.pos] : undefined;
}

function takeToken(state: ParserState): string | undefined {
  const token = peekToken(state);
  state.pos += 1;
  return token;
}

function parseAtom(state: ParserState): QueryNode {
  const token = takeToken(state);
  if (token === undefined) {
    throw new Error("query ends early");
  }
  if (token === "(") {
    const node = parseOr(state);
    if (takeToken(state) !== ")") {
      throw new Error("missing )");
    }
    return node;
  }
  if (token === "AND" || token === "OR" || token === ")") {
    throw new Error(`unexpected ${JSON.stringify(token)}`);
  }
  if (state.negated > 0) {
    state.excluded.push(token);
  } else {
    state.terms.push(token);
  }
  return { kind: "term", term: token };
}

function parseNot(state: ParserState): QueryNode {
  if (peekToken(state) === "NOT") {
    takeToken(state);
    state.negated += 1;
    const child = parseNot(state);
    state.negated -= 1;
    return { kind: "not", child };
  }
  return parseAtom(state);
}

function parseAnd(state: ParserState): QueryNode {
  const nodes: QueryNode[] = [parseNot(state)];
  for (;;) {
    const next = peekToken(state);
    if (next === undefined || next === ")" || next === "OR") break;
    if (next === "AND") {
      takeToken(state);
    }
    nodes.push(parseNot(state));
  }
  const first = nodes[0];
  if (nodes.length === 1 && first !== undefined) return first;
  return { kind: "and", children: nodes };
}

function parseOr(state: ParserState): QueryNode {
  const nodes: QueryNode[] = [parseAnd(state)];
  while (peekToken(state) === "OR") {
    takeToken(state);
    nodes.push(parseAnd(state));
  }
  const first = nodes[0];
  if (nodes.length === 1 && first !== undefined) return first;
  return { kind: "or", children: nodes };
}

export function parseQuery(query: string): QueryParseResult {
  const state: ParserState = {
    tokens: tokenizeQuery(query),
    pos: 0,
    negated: 0,
    terms: [],
    excluded: [],
  };
  try {
    const tree = parseOr(state);
    if (state.pos !== state.tokens.length) {
      const stray = state.tokens[state.pos] ?? "";
      throw new Error(`unexpected ${JSON.stringify(stray)}`);
    }
    return {
      ok: true,
      query: {
        raw: query,
        tree,
        terms: state.terms,
        excluded: state.excluded,
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `${detail} in query ${JSON.stringify(query)}`,
    };
  }
}

function matchesQuery(node: QueryNode, normalisedText: string): boolean {
  if (node.kind === "term") return hasTerm(normalisedText, node.term);
  if (node.kind === "not") return !matchesQuery(node.child, normalisedText);
  if (node.kind === "and") {
    return node.children.every((child) => matchesQuery(child, normalisedText));
  }
  return node.children.some((child) => matchesQuery(child, normalisedText));
}

function uniqueTerms(terms: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const term of terms) {
    if (!seen.has(term)) {
      seen.add(term);
      ordered.push(term);
    }
  }
  return ordered;
}

export function evaluateQuery(
  parsed: ParsedQuery,
  normalisedText: string,
): QueryEvaluation {
  const hit = matchesQuery(parsed.tree, normalisedText);
  const absent = uniqueTerms(parsed.terms).filter(
    (term) => !hasTerm(normalisedText, term),
  );
  const excludedPresent = uniqueTerms(parsed.excluded).filter((term) =>
    hasTerm(normalisedText, term),
  );
  return { hit, absent, excludedPresent };
}
