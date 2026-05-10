// Multi-class Brier score for probabilistic scenario predictions.
//
// Standard formula: BS = (1/N) * sum_i(f_i - o_i)^2
// where f_i = forecast probability for outcome i, o_i = 1 if outcome i occurred else 0.
// Lower is better: 0.0 = perfect, 1.0 = worst possible.

export interface ScoredScenario {
  label: string;
  probability: number; // forecast probability
  materialised: boolean;
}

export function computeBrierScore(scenarios: ScoredScenario[]): number {
  if (scenarios.length === 0) return 1.0;

  const sum = scenarios.reduce((acc, s) => {
    const o = s.materialised ? 1 : 0;
    return acc + Math.pow(s.probability - o, 2);
  }, 0);

  return Math.round((sum / scenarios.length) * 10000) / 10000;
}

// Calibration label based on Brier score ranges (for display)
export function brierLabel(score: number): string {
  if (score <= 0.10) return "Excellent";
  if (score <= 0.20) return "Good";
  if (score <= 0.33) return "Acceptable";
  if (score <= 0.50) return "Poor";
  return "Very poor";
}
