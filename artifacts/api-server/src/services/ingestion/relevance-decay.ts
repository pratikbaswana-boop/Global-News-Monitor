// Blueprint spec: effective_weight = credibility_score × e^(−λ × days_since_published)
// λ = 0.15 for fast-moving stories (conflict, sanctions, military)
// λ = 0.05 for slow-moving stories (trade negotiations, diplomacy, economic)

const CREDIBILITY_SCORES: Record<number, number> = {
  1: 1.0, // wire service
  2: 0.8, // established media
  3: 0.5, // state media
  4: 0.9, // think tank / analysis
};

// CAMEO action types that warrant fast decay (λ=0.15)
const FAST_DECAY_ACTIONS = new Set([
  "MOBILIZE_MILITARY",
  "SANCTION",
  "IMPOSE_EMBARGO",
  "THREATEN",
  "CONDEMN",
  "EXPEL_DIPLOMAT",
  "CEASEFIRE",
  "PROTEST",
]);

export function computeEffectiveWeight(
  credibilityTier: number,
  publishedAt: Date,
  actionType: string
): number {
  const credScore = CREDIBILITY_SCORES[credibilityTier] ?? 0.5;
  const daysSince = (Date.now() - publishedAt.getTime()) / (1000 * 60 * 60 * 24);
  const lambda = FAST_DECAY_ACTIONS.has(actionType) ? 0.15 : 0.05;
  return credScore * Math.exp(-lambda * daysSince);
}

export function isFastDecayAction(actionType: string): boolean {
  return FAST_DECAY_ACTIONS.has(actionType);
}
