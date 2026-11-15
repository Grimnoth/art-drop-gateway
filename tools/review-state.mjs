/** Derive review state without changing the flags, notes or prior team decisions. */
export const artVersion = (update) => update ? `${update.tag}:${update.at}` : "";

export function reviewStatus(reviews, update, triage) {
  if (update && reviews.some((r) => r.verdict === "flag" && r.art_version !== artVersion(update))) return "rereview";
  if (update && triage && triage.at <= update.at) return "";
  return triage?.status || "";
}
