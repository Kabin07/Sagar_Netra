/**
 * Severity heuristic carried over from the original prototype (legacy/fastapi_prototype_server.py).
 * Only `trash_*` detections count as debris; animals, plants and the ROV never raise
 * severity. Mask coverage is a fraction of the frame, NOT a calibrated area in m².
 */
// trash_rope counts as lost fishing gear alongside trash_net: on the val set the model's
// "net" false alarms were all tangled rope, and net + rope together are detected with
// no false alarms (docs/review/eval_v2).
const HIGH = new Set(['trash_net', 'trash_rope', 'trash_wreckage', 'trash_tarp']);
const LOW = new Set(['trash_bottle', 'trash_cup', 'trash_can', 'trash_snack_wrapper']);
const RANK = { none: 0, low: 1, med: 2, high: 3 };

export function detectionSeverity(className, areaFrac) {
  if (!className.startsWith('trash_')) return 'none';
  const frac = areaFrac ?? 0;
  if (HIGH.has(className) || frac > 0.18) return 'high';
  if (LOW.has(className) && frac < 0.05) return 'low';
  return 'med';
}

/** Highest severity among non-false-positive detections; null when no inference has completed. */
export function reportSeverity(detections, { anyCompleted }) {
  if (!anyCompleted) return null;
  let best = 'none';
  for (const d of detections) {
    if (d.status === 'false_positive') continue;
    const s = detectionSeverity(d.className ?? d.type_name, d.areaFrac ?? d.mask_area_frac);
    if (RANK[s] > RANK[best]) best = s;
  }
  return best;
}
