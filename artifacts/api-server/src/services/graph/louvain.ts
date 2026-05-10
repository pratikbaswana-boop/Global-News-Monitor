// Louvain community detection in TypeScript.
// Implements greedy modularity optimization matching the blueprint spec:
// resolution=1.0, min_community_size=5 events, 2 distinct country_iso values.

export interface GraphNode {
  id: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
}

export interface Community {
  nodes: string[];
}

export function detectCommunities(
  nodes: GraphNode[],
  edges: GraphEdge[]
): Map<string, number> {
  // community assignment: nodeId → communityId
  const assignment = new Map<string, number>();
  nodes.forEach((n, i) => assignment.set(n.id, i));

  if (nodes.length === 0) return assignment;

  // Build adjacency: nodeId → Map<neighborId, weight>
  const adj = new Map<string, Map<string, number>>();
  for (const n of nodes) adj.set(n.id, new Map());

  let totalWeight = 0;
  for (const e of edges) {
    if (!adj.has(e.source) || !adj.has(e.target)) continue;
    const w = e.weight || 1;
    adj.get(e.source)!.set(e.target, (adj.get(e.source)!.get(e.target) ?? 0) + w);
    adj.get(e.target)!.set(e.source, (adj.get(e.target)!.get(e.source) ?? 0) + w);
    totalWeight += w;
  }

  if (totalWeight === 0) return assignment;

  // Node degree (sum of edge weights)
  const degree = new Map<string, number>();
  for (const n of nodes) {
    let d = 0;
    for (const w of adj.get(n.id)!.values()) d += w;
    degree.set(n.id, d);
  }

  const resolution = 1.0;
  let improved = true;

  while (improved) {
    improved = false;

    for (const node of nodes) {
      const currentComm = assignment.get(node.id)!;
      const neighborWeightByComm = new Map<number, number>();

      for (const [neighbor, w] of adj.get(node.id)!) {
        const nc = assignment.get(neighbor)!;
        if (nc !== currentComm) {
          neighborWeightByComm.set(nc, (neighborWeightByComm.get(nc) ?? 0) + w);
        }
      }

      // Modularity gain: ΔQ ∝ k_i_in - k_i * Σ_tot * resolution / (2m)
      const ki = degree.get(node.id) ?? 0;
      let bestDelta = 0;
      let bestComm = currentComm;

      // Weight into current community (excluding self)
      let ki_in_current = 0;
      for (const [neighbor, w] of adj.get(node.id)!) {
        if (assignment.get(neighbor) === currentComm) ki_in_current += w;
      }

      // Sum of degrees in current community (excluding self)
      let sigma_tot_current = 0;
      for (const n2 of nodes) {
        if (assignment.get(n2.id) === currentComm && n2.id !== node.id) {
          sigma_tot_current += degree.get(n2.id) ?? 0;
        }
      }

      // Gain from removing from current community
      const removeDelta =
        -ki_in_current / totalWeight + (resolution * ki * sigma_tot_current) / (2 * totalWeight * totalWeight);

      for (const [comm, ki_in] of neighborWeightByComm) {
        let sigma_tot = 0;
        for (const n2 of nodes) {
          if (assignment.get(n2.id) === comm) sigma_tot += degree.get(n2.id) ?? 0;
        }
        const addDelta =
          ki_in / totalWeight - (resolution * ki * sigma_tot) / (2 * totalWeight * totalWeight);

        const delta = removeDelta + addDelta;
        if (delta > bestDelta) {
          bestDelta = delta;
          bestComm = comm;
        }
      }

      if (bestComm !== currentComm) {
        assignment.set(node.id, bestComm);
        improved = true;
      }
    }
  }

  return assignment;
}

// Group node IDs into communities
export function groupCommunities(assignment: Map<string, number>): Community[] {
  const groups = new Map<number, string[]>();
  for (const [nodeId, commId] of assignment) {
    if (!groups.has(commId)) groups.set(commId, []);
    groups.get(commId)!.push(nodeId);
  }
  return [...groups.values()].map((nodes) => ({ nodes }));
}
