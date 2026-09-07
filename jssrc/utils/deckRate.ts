// A standard single-value EMA of seconds-per-card: emaSeconds = alpha*dt +
// (1-alpha)*emaSeconds. null means no sample has ever been folded in yet
// (nothing to seed from) - the first real sample sets emaSeconds directly
// rather than blending against a fake zero/undefined baseline, so a fresh
// deck's very first card doesn't bias every estimate after it.
export interface RateState {
  emaSeconds: number | null;
}

// Nothing reads or writes the per-deck rate store anymore - kept only so
// index.ts's stale-key GC can still purge legacy entries from old installs.
export const kDeckRates = '__rt__deckrates__'
