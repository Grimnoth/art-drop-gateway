/** Derive review state without changing the flags, notes or prior team decisions. */
export function reviewStatus(reviews, update, triage) {
  if (update && reviews.some((r) => r.verdict === "flag" && r.at <= update.at)) return "rereview";
  if (update && triage && triage.at <= update.at) return "";
  return triage?.status || "";
}
