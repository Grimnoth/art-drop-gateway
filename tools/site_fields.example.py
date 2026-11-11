"""Example of a project's site fields. Copy it to tools/site_fields.py (never committed) and edit it.

pull_update.py calls refresh(item, row) for every item on the site, with that item's row from the release's
ID manifest. Set the item fields that the gallery shows. The gallery knows these optional fields:

  qc       a delivery note          caveat   true marks the note as a caveat (a filter)
  prov     provisional background   cleanup  the artist changed the figure on request
  scope    background review note   src      background source
  mint     true puts the item in the chosen set, which the gallery can label (CHOSEN_LABEL)
"""
import re

CAVEAT = re.compile(r"approximate|partial|not exact", re.I)


def refresh(item, row):
    note = row.get("character_QC_reason")
    if note is not None:
        item["qc"] = note
        item["caveat"] = bool(CAVEAT.search(note))
