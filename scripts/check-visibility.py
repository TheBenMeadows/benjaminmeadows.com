#!/opt/homebrew/bin/python3
"""Check that nothing on the site goes past what the private fact base marks public.

The fact base is not in this repository. Each fact in it has a visibility; only
`public` facts may appear here. This script reads it from a local path and fails when:

  1. a content item cites no fact, an unknown fact, or a fact that is not public
  2. the built pages contain a figure that appears only in non-public facts
  3. the built pages contain a four-word run that appears only in non-public facts
  4. the built pages contain a phrase the fact base's own rules forbid
  5. the built pages contain a phrase from the private list beside the fact base

The figures and phrases in 2 and 3 are derived at run time, so this file can be
public without repeating what it guards.

    scripts/check-visibility.py [--facts ~/Projects/career/facts.json]
"""
import argparse
import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FACTS = Path.home() / "Projects/career/facts.json"

# Wording rules from the fact base README. None of these is itself sensitive.
FORBIDDEN = [
    (r"\bVP of Operations\b", "titles are exact: Vice President, Internal Operations"),
    (r"permanent collection", "say 'collection'"),
    (r"\bmanufacturing\b|production[- ]floor|\blean\b", "no manufacturing or lean claims"),
    (r"\bfull P&L\b", "the Fortiline P&L is always 'joint'"),
    (r"btmeadows", "dead LinkedIn URL"),
    (r"\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b", "no phone number on the site"),
    (r"open to relocation", "not for a public page"),
]

EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")

# Sections of the public LinkedIn profile that content may cite.
LINKEDIN_SECTIONS = {
    f"linkedin:{s}"
    for s in ("about", "experience", "education", "certifications", "courses", "skills", "languages", "volunteering", "projects")
}

FIGURE = re.compile(r"\$[\d,.]+[MKmk]?|\b\d+(?:\.\d+)?%|\b\d{1,3}(?:,\d{3})+\b")


def words(text):
    return re.findall(r"[a-z0-9$%&']+", text.lower())


def grams(text, n=4):
    w = words(text)
    return {" ".join(w[i : i + n]) for i in range(len(w) - n + 1)}


def cited(node, trail="", covered=False):
    """Yield (where, fact ids) for every content object that carries copy.

    An object with copy and no `facts` of its own is covered by the nearest
    ancestor that has them; with no such ancestor it yields an empty list.
    """
    if isinstance(node, list):
        for i, item in enumerate(node):
            yield from cited(item, f"{trail}[{i}]", covered)
    elif isinstance(node, dict):
        if "facts" in node:
            yield trail, node["facts"]
            covered = True
        elif not covered and ("text" in node or "paragraphs" in node):
            yield trail, []
        for key, value in node.items():
            if key not in ("facts", "person"):
                yield from cited(value, f"{trail}.{key}" if trail else key, covered)


def check_refs(facts):
    problems = []
    for name in ("site.json", "recommendations.json", "speaking.json"):
        doc = json.loads((ROOT / "content" / name).read_text())
        for where, ids in cited(doc):
            if not ids:
                problems.append(f"{name} {where}: cites no fact")
            for fid in ids:
                if fid.startswith("linkedin:"):
                    if fid not in LINKEDIN_SECTIONS:
                        problems.append(f"{name} {where}: unknown LinkedIn section '{fid}'")
                    continue
                fact = facts.get(fid)
                if fact is None:
                    problems.append(f"{name} {where}: unknown fact '{fid}'")
                elif fact["visibility"] != "public":
                    problems.append(f"{name} {where}: '{fid}' is {fact['visibility']}, not public")
    return problems


def site_text():
    chunks = []
    for page in sorted((ROOT / "dist").rglob("*.html")):
        # Structured data is page content too, so only its tags are dropped.
        raw = re.sub(r"<script\b(?![^>]*ld\+json).*?</script>", " ", page.read_text(), flags=re.S)
        # Text that ships inside attributes: meta descriptions, alt text, labels.
        attrs = " ".join(re.findall(r'\b(?:content|alt|title|aria-label|placeholder)="([^"]*)"', raw))
        chunks.append(html.unescape(re.sub(r"<[^>]+>", " ", raw) + " " + attrs))
    chunks.append((ROOT / "dist/search-index.json").read_text())
    return "\n".join(chunks)


def quoted_public(facts):
    """Verbatim recommendation text whose own citation is public.

    The fact base records that these recommendations exist, not their wording, so
    their wording has to be counted as public here or it collides with ordinary
    phrases in non-public quotes.
    """
    doc = json.loads((ROOT / "content/recommendations.json").read_text())
    shared = doc.get("facts", [])
    out = []
    for item in doc["items"]:
        ids = item.get("facts", shared)
        if ids and all(facts.get(i, {}).get("visibility") == "public" for i in ids):
            out.append(item["text"])
    return " ".join(out)


def check_leaks(facts, text):
    public = " ".join(f["statement"] for f in facts.values() if f["visibility"] == "public")
    public += " " + quoted_public(facts)
    hidden = [f for f in facts.values() if f["visibility"] != "public"]
    public_figures = set(FIGURE.findall(public))
    public_grams = grams(public)
    site_figures = set(FIGURE.findall(text))
    site_grams = grams(text)
    problems = []
    for fact in hidden:
        body = fact["statement"] + " " + fact.get("note", "")
        for fig in sorted(set(FIGURE.findall(body)) - public_figures):
            if fig in site_figures:
                problems.append(f"figure from non-public fact '{fact['id']}' is on the site")
        for gram in sorted(grams(fact["statement"]) - public_grams):
            if gram in site_grams:
                problems.append(f"wording from non-public fact '{fact['id']}' is on the site")
    return problems


def check_forbidden(text):
    return [f"forbidden wording ({why}): /{pat}/" for pat, why in FORBIDDEN if re.search(pat, text, flags=re.I)]


def check_contact():
    """The only email address on the built pages, links included, is the one in content/site.json."""
    allowed = json.loads((ROOT / "content/site.json").read_text())["person"]["email"].lower()
    raw = " ".join(p.read_text() for p in sorted((ROOT / "dist").rglob("*.html")))
    raw += (ROOT / "dist/search-index.json").read_text()
    others = sorted({e.lower() for e in EMAIL.findall(raw)} - {allowed})
    return [f"an email address other than the site's contact is on the site ({len(others)} found)"] if others else []


def check_private_phrases(facts_path, text):
    """Phrases listed in site-banned.txt beside the fact base.

    The resume paraphrases non-public facts, and a paraphrase shares no wording
    with the fact base, so those phrases are listed by hand in a private file.
    A hit is reported by line number so this output never repeats the phrase.
    """
    listing = facts_path.parent / "site-banned.txt"
    if not listing.exists():
        return [f"private phrase list not found at {listing}"]
    flat = re.sub(r"\s+", " ", text).lower()
    problems = []
    for n, line in enumerate(listing.read_text().splitlines(), 1):
        phrase = line.strip().lower()
        if phrase and not phrase.startswith("#") and phrase in flat:
            problems.append(f"private phrase on the site: {listing.name} line {n}")
    return problems


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--facts", type=Path, default=DEFAULT_FACTS)
    args = ap.parse_args()
    if not args.facts.exists():
        sys.exit(f"fact base not found at {args.facts}")
    if not (ROOT / "dist/index.html").exists():
        sys.exit("dist/ is missing: run `node build.mjs` first")
    facts = {f["id"]: f for f in json.loads(args.facts.read_text())["facts"]}
    text = site_text()
    found = check_refs(facts) + check_leaks(facts, text) + check_forbidden(text) + check_contact() + check_private_phrases(args.facts, text)
    problems = list(dict.fromkeys(found))
    for p in problems:
        print("FAIL", p)
    if problems:
        sys.exit(1)
    print(f"ok: every citation is public, and nothing from {sum(f['visibility'] != 'public' for f in facts.values())} non-public facts is on the site")


if __name__ == "__main__":
    main()
