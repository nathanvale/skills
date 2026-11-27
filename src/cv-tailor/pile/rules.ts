export type CompetitorPage = {
  readonly name: string;
  readonly text: string;
};

export type BuiltPile = {
  readonly number: number;
  readonly filename: string;
  readonly version: "new" | "old";
  readonly targetPosition: number;
  readonly labels: readonly string[];
  readonly content: string;
};

export type BuiltPilesResult = {
  readonly seed: number;
  readonly piles: readonly BuiltPile[];
  readonly keyLines: readonly string[];
  readonly keyText: string;
};

export type BuildPilesInput = {
  readonly competitors: readonly CompetitorPage[];
  readonly newPageText: string;
  readonly oldPageText: string;
  readonly runs: number;
  readonly seed: number;
};

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomIndex(nextFloat: () => number, limit: number): number {
  return Math.floor(nextFloat() * limit);
}

function shuffleCopy<T>(items: readonly T[], nextFloat: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = randomIndex(nextFloat, index + 1);
    const current = copy[index];
    const chosen = copy[swap];
    if (current !== undefined && chosen !== undefined) {
      copy[index] = chosen;
      copy[swap] = current;
    }
  }
  return copy;
}

function formatPileContent(pages: readonly CompetitorPage[]): string {
  return `${pages
    .map(
      (page, index) =>
        `===== CANDIDATE C${String(index + 1)} =====\n${page.text.trim()}`,
    )
    .join("\n\n")}\n`;
}

export function buildPiles(input: BuildPilesInput): BuiltPilesResult {
  const nextFloat = createSeededRandom(input.seed);
  const slots = input.competitors.length + 1;
  const allSlots = Array.from({ length: slots }, (_, index) => index);
  const distinctPositions = shuffleCopy(allSlots, nextFloat).slice(
    0,
    Math.min(input.runs, slots),
  );
  const extraCount = Math.max(0, input.runs - distinctPositions.length);
  const newPositions = [...distinctPositions];
  for (let index = 0; index < extraCount; index += 1) {
    newPositions.push(randomIndex(nextFloat, slots));
  }

  const schedule: readonly {
    readonly version: "new" | "old";
    readonly text: string;
    readonly pos: number;
  }[] = [
    ...newPositions.map((pos) => ({
      version: "new" as const,
      text: input.newPageText,
      pos,
    })),
    {
      version: "old" as const,
      text: input.oldPageText,
      pos: randomIndex(nextFloat, slots),
    },
  ];

  const piles: BuiltPile[] = [];
  const keyLines: string[] = [`seed ${String(input.seed)}`];

  for (let index = 0; index < schedule.length; index += 1) {
    const entry = schedule[index];
    if (entry === undefined) continue;
    const number = index + 1;
    const shuffled = shuffleCopy(input.competitors, nextFloat);
    const target: CompetitorPage = {
      name: `TARGET (${entry.version})`,
      text: entry.text,
    };
    const pages: CompetitorPage[] = [
      ...shuffled.slice(0, entry.pos),
      target,
      ...shuffled.slice(entry.pos),
    ];
    const labels = pages.map(
      (page, pageIndex) => `C${String(pageIndex + 1)}=${page.name}`,
    );
    keyLines.push(
      `pile-${String(number)} (${entry.version}): target is C${String(entry.pos + 1)}; ${labels.join(", ")}`,
    );
    piles.push({
      number,
      filename: `pile-${String(number)}.txt`,
      version: entry.version,
      targetPosition: entry.pos,
      labels,
      content: formatPileContent(pages),
    });
  }

  return {
    seed: input.seed,
    piles,
    keyLines,
    keyText: `${keyLines.join("\n")}\n`,
  };
}
