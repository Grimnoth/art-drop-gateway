/** Derive review state without changing the flags, notes or prior team decisions. */
export const artVersion = (update) => update ? `${update.tag}:${update.at}` : "";

export function backgroundOption(item, archive) {
  const option = archive?.items?.[item?.id];
  if (!option?.previous?.v || !option?.delivered?.v || item.upd?.tag !== archive.tag || (item.tv || "") !== option.delivered.tv) return null;
  for (const layer of ["character", "background", "combined"]) {
    if ((item.v?.[layer] || "") !== option.delivered.v[layer]) return null;
  }
  return option.previous.v.character === option.delivered.v.character ? option : null;
}

export function backgroundSelection(item, archive, selections) {
  const option = backgroundOption(item, archive);
  const selection = selections[item?.id];
  return option && selection?.source === option.delivered.v.combined ? selection : null;
}

export function backgroundReviewUpdate(selection, deliveryUpdate) {
  return selection ? { tag: `background-${selection.seq}`, at: selection.at } : deliveryUpdate;
}

export function reviewStatus(reviews, update, triage) {
  if (update && reviews.some((r) => r.verdict === "flag" && r.art_version !== artVersion(update))) return "rereview";
  if (update && triage && triage.at <= update.at) return "";
  return triage?.status || "";
}
