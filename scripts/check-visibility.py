#!/opt/homebrew/bin/python3
"""Check that nothing on the site goes past what the private fact base marks public.

The fact base is not in this repository. Each fact in it has a visibility; only
`public` facts may appear here. This script builds the site, reads the fact base
from a local path, and fails when:

  1. a content item with copy cites no fact, an unknown fact, or a fact that is not public
  2. the built site contains a figure that appears only in non-public facts
  3. the built site contains a four-word run that appears only in non-public facts
  4. the built site contains a name that appears only in non-public text
  5. the built site contains a phone number from the fact base
  6. the built site contains a phrase the fact base's own rules forbid
  7. the built site contains a phrase from the private list beside the fact base
  8. the built site contains an email address other than the site's contact
  9. an image in the built site carries metadata

The figures, wording, names and numbers in 2 to 5 are derived at run time, and
a failure names the fact or the file rather than what it found, so this file
and its output can be public without repeating what it guards.

    scripts/check-visibility.py [--facts ~/Projects/career/facts.json] [--no-build]
"""
import argparse
import html
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
DEFAULT_FACTS = Path.home() / "Projects/career/facts.json"

# Wording rules from the fact base README. None of these is itself sensitive.
FORBIDDEN = [
    (r"\bVP of Operations\b", "titles are exact: Vice President, Internal Operations"),
    (r"permanent collection", "say 'collection'"),
    (r"\bmanufacturing\b|production[- ]floor|\blean\b", "no manufacturing or lean claims"),
    (r"\bfull P&L\b", "the Fortiline P&L is always 'joint'"),
    (r"btmeadows", "dead LinkedIn URL"),
    (r"(?:\+1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}\b", "no phone number on the site"),
    (r"open to relocation", "not for a public page"),
]

EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
PHONE = re.compile(r"(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b")

# Sections of the public LinkedIn profile that content may cite.
LINKEDIN_SECTIONS = {
    f"linkedin:{s}"
    for s in ("about", "experience", "education", "certifications", "courses", "skills", "languages", "volunteering", "projects")
}

# Content keys whose strings are not copy: ids, dates, links, and notes to editors.
NOT_COPY = {"id", "date", "start", "end", "kind", "href", "link", "source", "_comment", "updated", "origin", "linkedin", "personalSite", "email"}

# Files in dist/ read as text, and images read for metadata.
TEXT_SUFFIXES = {".html", ".json", ".xml", ".txt", ".svg", ".js", ".css", ".webmanifest", ""}
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".heic", ".tif", ".tiff"}
# EXIF and XMP in JPEG, WebP and HEIF, IPTC in JPEG, and PNG's text and EXIF chunks.
IMAGE_METADATA = [b"Exif\0\0", b"http://ns.adobe.com/xap/1.0/", b"Photoshop 3.0\0", b"tEXt", b"iTXt", b"zTXt", b"eXIf", b"XMP "]

FIGURE = re.compile(
    r"\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|thousand|billion)\b|[MKBmkb]\b)?"
    r"|\b\d+(?:\.\d+)?\s?%"
    r"|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b"
)
SCALE = {"k": 1e3, "thousand": 1e3, "m": 1e6, "million": 1e6, "b": 1e9, "billion": 1e9}

# Month and weekday names and their short forms are not names to guard.
MONTHS = {
    m.lower()
    for m in "January February March April May June July August September October November December "
    "Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec Monday Tuesday Wednesday Thursday Friday Saturday Sunday".split()
}

# Names a public fact's note approves for the site while its statement does
# not carry them. Each is already on the published site.
#   gib-peers, Ben 2026-09-20: the Kimbel Mechanical exchange, cancelled by COVID
#   edu-harvardx: "Harvard University via edX"
APPROVED_NAMES = {"kimbel", "mechanical", "covid", "harvard"}

QUOTES = str.maketrans({"’": "'", "‘": "'", "“": '"', "”": '"'})

# A capitalised word that does not start a sentence, or one with a capital or a
# digit inside it anywhere: a name, a vendor, a product, a network number.
NAME = re.compile(r"(?<![.!?:]\s)(?<!^)\b[A-Z][A-Za-z0-9&'-]*[A-Za-z0-9]", re.M)
CAPITALISED = re.compile(r"\b[A-Z][A-Za-z0-9&'-]*[A-Za-z0-9]")


def names(text):
    return set(NAME.findall(text)) | {w for w in CAPITALISED.findall(text) if re.search(r"[A-Z0-9]", w[1:])}


def plain(text):
    return re.sub(r"\s+", " ", text.translate(QUOTES))


def words(text):
    return re.findall(r"[a-z0-9$%&']+", plain(text).lower())


def grams(text, n=4):
    w = words(text)
    return {" ".join(w[i : i + n]) for i in range(len(w) - n + 1)}


def figure_value(fig):
    """A figure as a comparable value, so `$84,000.` and `$84K` and `6%` and
    `6.0%` each match the other way of writing them."""
    fig = fig.strip().rstrip(",")
    if fig.endswith("%"):
        return ("%", float(fig[:-1].strip()))
    if fig.startswith("$"):
        m = re.match(r"\$\s?([\d,]+(?:\.\d+)?)\s?([A-Za-z]*)", fig)
        number = float(m.group(1).replace(",", "").rstrip(".") or 0)
        return ("$", number * SCALE.get(m.group(2).lower(), 1))
    return ("#", float(fig.replace(",", "")))


def figures(text):
    return {figure_value(f) for f in FIGURE.findall(plain(text))}


def has_copy(value):
    if isinstance(value, str):
        return bool(value.strip())
    return isinstance(value, list) and any(isinstance(v, str) and v.strip() for v in value)


def cited(node, trail="", covered=False):
    """Yield (where, fact ids) for every content object that carries copy.

    Copy is any string, or list of strings, under a key that is not an id, a
    date, a link or a note. An object with copy and no `facts` of its own is
    covered by the nearest ancestor that has them; with no such ancestor it
    yields an empty list.
    """
    if isinstance(node, list):
        for i, item in enumerate(node):
            yield from cited(item, f"{trail}[{i}]", covered)
    elif isinstance(node, dict):
        if "facts" in node:
            yield trail or "(top level)", node["facts"]
            covered = True
        elif not covered and any(k not in NOT_COPY and has_copy(v) for k, v in node.items()):
            yield trail or "(top level)", []
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


def dist_files(suffixes):
    return [p for p in sorted(DIST.rglob("*")) if p.is_file() and p.suffix.lower() in suffixes]


def site_text():
    """Every text file the site ships, pages read as a visitor reads them."""
    chunks = []
    for path in dist_files(TEXT_SUFFIXES):
        raw = path.read_text(errors="replace")
        if path.suffix == ".html":
            # Structured data is page content too, so only its tags are dropped.
            raw = re.sub(r"<script\b(?![^>]*ld\+json).*?</script>", " ", raw, flags=re.S)
            # Text that ships inside attributes: descriptions, alt text, labels, links.
            attrs = " ".join(re.findall(r'\b(?:content|alt|title|aria-label|placeholder|href)="([^"]*)"', raw))
            raw = re.sub(r"<[^>]+>", " ", raw) + " " + attrs
        chunks.append(html.unescape(raw))
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


def public_text(facts):
    person = json.loads((ROOT / "content/site.json").read_text())["person"]
    names = " ".join(str(v) for v in person.values() if isinstance(v, str))
    # A public fact's statement and the organisation it belongs to.
    statements = " ".join(f"{f['statement']} {f.get('org', '')}" for f in facts.values() if f["visibility"] == "public")
    return statements + " " + quoted_public(facts) + " " + names


def strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, list):
        for item in node:
            yield from strings(item)
    elif isinstance(node, dict):
        for key, value in node.items():
            if key != "facts":
                yield from strings(value)


def linkedin_copy(node):
    """Copy that cites the public LinkedIn profile, whose text the fact base
    does not hold: organisations, titles, courses and places named there."""
    if isinstance(node, list):
        for item in node:
            yield from linkedin_copy(item)
    elif isinstance(node, dict):
        if any(str(f).startswith("linkedin:") for f in node.get("facts", [])):
            yield from strings(node)
        else:
            for value in node.values():
                yield from linkedin_copy(value)


def check_leaks(facts, text):
    public = public_text(facts)
    public_figures = figures(public)
    public_grams = grams(public)
    site_figures = figures(text)
    site_grams = grams(text)
    problems = []
    for fact in facts.values():
        if fact["visibility"] == "public":
            continue
        body = fact["statement"] + " " + fact.get("note", "")
        if (figures(body) - public_figures) & site_figures:
            problems.append(f"figure from non-public fact '{fact['id']}' is on the site")
        if (grams(fact["statement"]) - public_grams) & site_grams:
            problems.append(f"wording from non-public fact '{fact['id']}' is on the site")
    return problems


def check_names(facts, text):
    """Names, vendors and products that appear only where they may not be published.

    A four-word run cannot catch a single name, so every name in a non-public
    statement or in any fact's note (a capitalised word that does not start a
    sentence, or one with a capital or digit inside it) is checked unless it
    also appears in a public statement, a public quote, the site's own person
    block, copy that cites the LinkedIn profile, or anywhere in lower case.
    Abbreviations of three capitals or fewer (VP, TX) and month names pass.
    """
    public = public_text(facts)
    for name in ("site.json", "recommendations.json", "speaking.json"):
        public += " " + " ".join(linkedin_copy(json.loads((ROOT / "content" / name).read_text())))
    known = {w.lower() for w in re.findall(r"[A-Za-z0-9&'-]+", plain(public))} | MONTHS | APPROVED_NAMES
    lower = set()
    for f in facts.values():
        lower |= set(re.findall(r"\b[a-z][a-z0-9&'-]*", plain(f["statement"] + " " + f.get("note", ""))))
    site = plain(text)
    problems = []
    for fact in facts.values():
        hidden = fact.get("note", "") if fact["visibility"] == "public" else fact["statement"] + " " + fact.get("note", "")
        for name in names(plain(hidden)):
            if name.lower() in known or name.lower() in lower or (name.isupper() and len(name) <= 3):
                continue
            if re.search(rf"(?<![A-Za-z0-9]){re.escape(name)}(?![A-Za-z0-9])", site):
                problems.append(f"a name from fact '{fact['id']}' that no public text uses is on the site")
                break
    return problems


def check_phones(facts, text):
    """Every phone number in the fact base, matched on its digits alone, so a
    number written with brackets, spaces, a leading +1 or nothing at all is
    still found."""
    numbers = set()
    for f in facts.values():
        for found in PHONE.findall(f["statement"] + " " + f.get("note", "")):
            digits = re.sub(r"\D", "", found)
            numbers.add(digits[-10:])
    site = re.sub(r"\D", "", text)
    return [f"a phone number from the fact base is on the site ({sum(n in site for n in numbers)} found)"] if any(n in site for n in numbers) else []


def check_forbidden(text):
    return [f"forbidden wording ({why}): /{pat}/" for pat, why in FORBIDDEN if re.search(pat, text, flags=re.I)]


def check_contact():
    """The only email address in the built site, links included, is the one in content/site.json."""
    allowed = json.loads((ROOT / "content/site.json").read_text())["person"]["email"].lower()
    raw = " ".join(p.read_text(errors="replace") for p in dist_files(TEXT_SUFFIXES))
    others = sorted({e.lower() for e in EMAIL.findall(raw)} - {allowed})
    return [f"an email address other than the site's contact is on the site ({len(others)} found)"] if others else []


def check_images():
    problems = []
    for path in dist_files(IMAGE_SUFFIXES):
        data = path.read_bytes()
        if any(marker in data for marker in IMAGE_METADATA):
            problems.append(f"image metadata in {path.relative_to(DIST)}")
    return problems


def check_private_phrases(facts_path, text):
    """Phrases listed in site-banned.txt beside the fact base.

    The resume paraphrases non-public facts, and a paraphrase shares no wording
    with the fact base, so those phrases are listed by hand in a private file.
    A hit is reported by line number so this output never repeats the phrase.
    """
    listing = facts_path.parent / "site-banned.txt"
    if not listing.exists():
        return [f"private phrase list not found at {listing}"]
    flat = plain(text).lower()
    problems = []
    for n, line in enumerate(listing.read_text().splitlines(), 1):
        phrase = plain(line).strip().lower()
        if phrase and not phrase.startswith("#") and phrase in flat:
            problems.append(f"private phrase on the site: {listing.name} line {n}")
    return problems


def build():
    """Build dist/ from the current sources, so the check never reads an older build."""
    node = shutil.which("node") or "/opt/homebrew/bin/node"
    run = subprocess.run([node, "build.mjs"], cwd=ROOT, capture_output=True, text=True)
    if run.returncode != 0:
        sys.exit(f"node build.mjs failed:\n{run.stderr[-2000:]}")


def stale():
    """With --no-build: whether any source is newer than the build."""
    built = (DIST / "index.html").stat().st_mtime
    sources = [ROOT / "build.mjs", *(ROOT / "content").glob("*.json"), *(p for p in (ROOT / "static").rglob("*") if p.is_file())]
    return any(p.stat().st_mtime > built for p in sources)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--facts", type=Path, default=DEFAULT_FACTS)
    ap.add_argument("--no-build", action="store_true", help="check the existing dist/, which must be newer than every source")
    args = ap.parse_args()
    if not args.facts.exists():
        sys.exit(f"fact base not found at {args.facts}")
    if not args.no_build:
        build()
    elif not (DIST / "index.html").exists():
        sys.exit("dist/ is missing: run `node build.mjs` first")
    elif stale():
        sys.exit("dist/ is older than its sources: run `node build.mjs` first")
    facts = {f["id"]: f for f in json.loads(args.facts.read_text())["facts"]}
    text = site_text()
    found = (
        check_refs(facts)
        + check_leaks(facts, text)
        + check_names(facts, text)
        + check_phones(facts, text)
        + check_forbidden(text)
        + check_contact()
        + check_images()
        + check_private_phrases(args.facts, text)
    )
    problems = list(dict.fromkeys(found))
    for p in problems:
        print("FAIL", p)
    if problems:
        sys.exit(1)
    print(f"ok: every citation is public, and nothing from {sum(f['visibility'] != 'public' for f in facts.values())} non-public facts is on the site")


if __name__ == "__main__":
    main()
