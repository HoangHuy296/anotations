import { createHash } from "node:crypto";
import { z } from "zod";

const referenceSchema = z.object({
  schemaVersion: z.literal(1),
  benchmarkId: z.literal("text-workspace-sc005-v1"),
  runtime: z.object({ node: z.string(), icu: z.string(), unicode: z.string() }),
  corpus: z.object({
    seed: z.number().int().min(1).max(0xffffffff),
    prng: z.literal("xorshift32"),
    encoding: z.literal("UTF8"), offsetUnit: z.literal("UTF16_CODE_UNIT"),
    prefix: z.string(), repeatUnit: z.string().min(1), pad: z.string().length(1),
    codeUnitLength: z.number().int().positive().max(1_000_000),
    sourceByteLength: z.number().int().positive(), sourceIdentity: z.string(),
    spans: z.number().int().positive().max(10000), nestedPairs: z.number().int().positive(),
    relations: z.number().int().nonnegative(),
    spanStartBoundaryIndex: z.literal("20 * floor(i / 2)"),
    spanEndBoundaryIndex: z.literal("start + (i % 2 == 0 ? 3 : 9)"),
    relationEndpoints: z.literal("shuffledSpanIndices[2*j] -> shuffledSpanIndices[2*j+1]"),
  }),
});

/** Test-only recipe. Symbolic indices are mapped to authorized records by fixtures. */
export function generateReferenceCorpus(input: unknown) {
  const { runtime, corpus } = referenceSchema.parse(input);
  if (Object.entries(runtime).some(([key, version]) => process.versions[key as keyof NodeJS.ProcessVersions] !== version)) {
    throw new Error("Benchmark runtime profile mismatch");
  }
  const available = corpus.codeUnitLength - corpus.prefix.length;
  if (available < 0 || corpus.spans !== corpus.nestedPairs * 2 || corpus.relations * 2 > corpus.spans) {
    throw new Error("Invalid benchmark dimensions");
  }
  let text = corpus.prefix + corpus.repeatUnit.repeat(Math.floor(available / corpus.repeatUnit.length));
  text += corpus.pad.repeat(corpus.codeUnitLength - text.length);
  const sourceIdentity = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  if (Buffer.byteLength(text) !== corpus.sourceByteLength || sourceIdentity !== corpus.sourceIdentity) {
    throw new Error("Benchmark source identity mismatch");
  }
  const boundaries = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text)].map((part) => part.index);
  boundaries.push(text.length);
  const spans = Array.from({ length: corpus.spans }, (_, index) => {
    const start = 20 * Math.floor(index / 2);
    const end = start + (index % 2 === 0 ? 3 : 9);
    if (end >= boundaries.length) throw new Error("Benchmark span exceeds source");
    return { index, startOffset: boundaries[start], endOffset: boundaries[end] };
  });
  let state = corpus.seed >>> 0;
  const next = () => {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return state;
  };
  const shuffled = spans.map((span) => span.index);
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = next() % (index + 1);
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  const relations = Array.from({ length: corpus.relations }, (_, index) => ({
    index, from: shuffled[2 * index], to: shuffled[2 * index + 1],
  }));
  return { sourceIdentity, text, boundaries, spans, relations };
}
