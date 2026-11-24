"""Carry a client's work onto a revised source PDF.

The designer sends version two. The client has already renamed a dish, dropped an item,
changed prices and added a note. Re-importing must not throw that away, and it must not
guess so hard that an edit lands on the wrong line.

Matching, strongest first, per edited or deleted line:

  1. the same words in the same slot   (page, text, x±2pt, y±1.5pt, size±0.75pt)
  2. the same words, anywhere on the same page, when they are unique on both sides
  3. the same slot, even though the designer changed the words there (x±2, y±1.5, same face)

Anything else is *orphaned* — reported with its words and page, never silently dropped. A
delete whose line is already gone from the new file is "already gone", which is fine.

What is carried is the edit, not the text: the client's patch still wins over the new file,
because the price is their decision. Added boxes ride along unless their page disappeared.
"""
import json


def _norm(s):
    return " ".join(str(s or "").split())


def _near(a, b, tx=2.0, ty=1.5, ts=0.75):
    try:
        return (abs(float(a["x"]) - float(b["x"])) <= tx
                and abs(float(a["y"]) - float(b["y"])) <= ty
                and abs(float(a["size"]) - float(b["size"])) <= ts)
    except (KeyError, TypeError, ValueError):
        return False


def _flat(doc):
    out = []
    for p in (doc or {}).get("pages") or []:
        for o in p.get("objects") or []:
            out.append(o)
    return out


def remap(old_doc, new_doc, work):
    """(new_work, report). Pure: no files, no HTTP — the caller decides what to store."""
    work = work or {}
    old_objs = {o.get("gi"): o for o in _flat(old_doc)}
    new_objs = [o for o in _flat(new_doc) if isinstance(o.get("gi"), int)]
    by_key = {}
    for o in new_objs:
        by_key.setdefault((o.get("page"), _norm(o.get("text"))), []).append(o)

    wanted = []
    seen = set()
    for e in work.get("edits") or []:
        gi = e[0] if isinstance(e, list) and e else (e.get("gi") if isinstance(e, dict) else e)
        if isinstance(gi, int) and gi not in seen:
            seen.add(gi)
            wanted.append(gi)
    for d in work.get("deletes") or []:
        gi = d[0] if isinstance(d, list) and d else (d.get("gi") if isinstance(d, dict) else d)
        if isinstance(gi, int) and gi not in seen:
            seen.add(gi)
            wanted.append(gi)

    claimed = {}          # new gi -> old gi, so two old lines cannot share one new line
    mapping = {}
    orphaned, conflicts, gone = [], [], []

    for gi in wanted:
        o = old_objs.get(gi)
        if not o:
            orphaned.append({"gi": gi, "text": "", "page": 0,
                             "reason": "that line is not in this project any more"})
            continue
        pick = None
        ox, oy = float(o["x"]), float(o["y"])
        # 1. same words in the same slot
        for c in by_key.get((o.get("page"), _norm(o.get("text"))), []):
            if c["gi"] in claimed or not _near(o, c):
                continue
            pick = c
            break
        # 2. same words on the page, when unambiguous on both sides
        if pick is None:
            cands = [c for c in by_key.get((o.get("page"), _norm(o.get("text"))), [])
                     if c["gi"] not in claimed]
            if len(cands) == 1:
                pick = cands[0]
            elif len(cands) > 1:
                best = min(cands, key=lambda c: abs(c["x"] - ox) + abs(c["y"] - oy))
                if abs(best["x"] - ox) + abs(best["y"] - oy) <= 60:
                    pick = best
        # 3. same slot, different words (the designer changed the line in place)
        if pick is None:
            slot = [c for c in new_objs
                    if c["gi"] not in claimed and c.get("page") == o.get("page") and _near(o, c)]
            if len(slot) == 1:
                pick = slot[0]

        if pick is None:
            orphaned.append({"gi": gi, "text": o.get("text", ""), "page": o.get("page", 0),
                             "reason": "no line in the new PDF matches it"})
            continue
        if pick["gi"] in claimed:
            conflicts.append({"gi": gi, "text": o.get("text", ""), "page": o.get("page", 0),
                              "onto": pick["gi"],
                              "reason": "two old lines point at one new line; the first was kept"})
            continue
        claimed[pick["gi"]] = gi
        mapping[gi] = pick["gi"]

    # ---- edits: re-key, and let two old lines on one new line merge ----------
    new_edits = []
    index = {}
    for e in work.get("edits") or []:
        gi, patch = (e[0], e[1]) if isinstance(e, list) and len(e) == 2 \
            else ((e.get("gi"), e.get("patch")) if isinstance(e, dict) else (e, {}))
        if gi not in mapping:
            continue
        ng = mapping[gi]
        if ng in index:
            merged = dict(new_edits[index[ng]][1])
            merged.update(patch or {})
            new_edits[index[ng]] = [ng, merged]
        else:
            index[ng] = len(new_edits)
            new_edits.append([ng, dict(patch or {})])

    # ---- deletes: re-key; a line already gone needs no delete ----------------
    new_deletes = []
    for d in work.get("deletes") or []:
        gi = d[0] if isinstance(d, list) and d else (d.get("gi") if isinstance(d, dict) else d)
        if gi in mapping:
            new_deletes.append(mapping[gi])
        else:
            o = old_objs.get(gi) or {}
            gone.append({"gi": gi, "text": o.get("text", ""), "page": o.get("page", 0),
                         "reason": "already absent from the new PDF"})

    # ---- added boxes: keep, unless the page they sit on is gone --------------
    n_pages = len((new_doc or {}).get("pages") or [])
    new_adds, dropped_adds = [], []
    for a in work.get("adds") or []:
        page = a.get("page", 0)
        if isinstance(page, int) and 0 <= page < n_pages:
            new_adds.append(a)
        else:
            dropped_adds.append({"page": page, "text": a.get("text", "")})

    # ---- sheet operations: a copy of a page that no longer exists is dropped -
    po = work.get("page_ops") or {}
    new_ops = {"new": [], "delete": []}
    dropped_ops = 0
    for op in po.get("new") or []:
        src = op.get("from")
        if src is None or (isinstance(src, int) and 0 <= src < n_pages):
            new_ops["new"].append(op)
        else:
            dropped_ops += 1
    for p in po.get("delete") or []:
        if isinstance(p, int) and 0 <= p < n_pages:
            new_ops["delete"].append(p)
        else:
            dropped_ops += 1

    new_work = {
        "edits": new_edits,
        "images": [im for im in (work.get("images") or []) if im.get("page", 0) < n_pages],
        "adds": new_adds,
        "deletes": new_deletes,
        "page_ops": new_ops,
    }
    report = {
        "old_lines": len(old_objs),
        "new_lines": len(new_objs),
        "carried": len(mapping),
        "orphaned": orphaned,
        "conflicts": conflicts,
        "gone": gone,
        "dropped_adds": dropped_adds,
        "dropped_page_ops": dropped_ops,
    }
    return new_work, report


def summary(report):
    """One line a client can read."""
    bits = []
    if report["carried"]:
        bits.append("%d change%s kept" % (report["carried"],
                                          "" if report["carried"] == 1 else "s"))
    if report["orphaned"]:
        bits.append("%d could not be matched" % len(report["orphaned"]))
    if report["gone"]:
        bits.append("%d already gone" % len(report["gone"]))
    if report["dropped_adds"]:
        bits.append("%d box%s on a missing page" % (len(report["dropped_adds"]),
                                                    "" if len(report["dropped_adds"]) == 1 else "es"))
    return ", ".join(bits) or "nothing to carry"
