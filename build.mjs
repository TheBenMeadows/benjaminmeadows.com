// Builds the site into dist/. No dependencies and no clock: every date in the
// output comes from content/, so one commit always produces the same bytes.
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, "dist");
const readJson = (name) => JSON.parse(readFileSync(join(ROOT, "content", name), "utf8"));

const site = readJson("site.json");
const recs = readJson("recommendations.json");
const talks = readJson("speaking.json");
const P = site.person;
const ORIGIN = site.origin;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const KINDS = [
    ["role", "Roles"],
    ["education", "Education"],
    ["credential", "Licenses & certifications"],
    ["board", "Boards & service"],
    ["speaking", "Speaking & press"],
];

const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Every link target from content goes through here: it must be an https URL, a
// mailto address, or a path on this site, and it is escaped for the attribute.
function href(url) {
    if (!/^(https:\/\/|mailto:|\/(?!\/))/.test(url)) throw new Error(`content has a link that is not https, mailto, or a site path: ${url}`);
    return esc(url);
}
if (!/^https:\/\/[a-z0-9.-]+$/.test(ORIGIN)) throw new Error(`site.json origin must be a bare https origin: ${ORIGIN}`);

// "2022-01" -> "Jan 2022"; "2012" -> "2012"; "present" -> "Present".
function fmtDate(d) {
    if (!d) return "";
    if (d === "present") return "Present";
    const [y, m] = d.split("-");
    return m ? `${MONTHS[Number(m) - 1]} ${y}` : y;
}
const fmtRange = (start, end) => (end && end !== start ? `${fmtDate(start)} to ${fmtDate(end)}` : fmtDate(start));
const yearRange = (start, end) => {
    const a = start.slice(0, 4);
    const b = end === "present" ? "Present" : end.slice(0, 4);
    return a === b ? a : `${a} to ${b}`;
};
const timeTag = (d) => (d && d !== "present" ? `<time datetime="${esc(d)}">${esc(fmtDate(d))}</time>` : esc(fmtDate(d)));
// A year with no month sorts as the end of that year.
const sortKey = (d) => (d.length === 4 ? `${d}-13` : d);

function hashed(name, body) {
    const h = createHash("sha256").update(body).digest("hex").slice(0, 10);
    return name.replace(/(\.\w+)$/, `-${h}$1`);
}

// These ship under content-hashed names, so a changed file gets a new URL and no
// browser or edge cache can keep serving the old one.
const HASHED = Object.fromEntries(
    ["styles.css", "site.js", "headshot-320.jpg", "headshot-640.jpg", "og.png"].map((f) => {
        const body = readFileSync(join(ROOT, "static", f));
        return [f, { body, name: hashed(f, body) }];
    }),
);
const asset = (f) => `/${HASHED[f].name}`;
const CSS_NAME = HASHED["styles.css"].name;
const JS_NAME = HASHED["site.js"].name;

// ---------------------------------------------------------------- structured data

function personLd() {
    const open = site.roles.filter((r) => r.end === "present");
    const current = open.length ? open : [site.roles[0]];
    return {
        "@type": "Person",
        "@id": `${ORIGIN}/#person`,
        name: P.name,
        alternateName: P.shortName,
        url: `${ORIGIN}/`,
        image: `${ORIGIN}${asset("headshot-640.jpg")}`,
        jobTitle: current[0].title,
        description: site.summary.paragraphs[0],
        address: { "@type": "PostalAddress", addressLocality: "Phoenix", addressRegion: "AZ", addressCountry: "US" },
        // A role names its employer by `ldOrg` when the printed name is not the
        // current legal one; `ldOrg: null` marks a role that is not employment.
        worksFor: current.filter((r) => r.ldOrg !== null).map((r) => ({ "@type": "Organization", name: r.ldOrg || r.org })),
        alumniOf: [{ "@type": "CollegeOrUniversity", name: "University of North Texas" }],
        hasCredential: site.credentials.flatMap((g) =>
            g.items.map((i) => ({ "@type": "EducationalOccupationalCredential", name: i.text, credentialCategory: g.group })),
        ),
        knowsAbout: site.skills.groups.filter((g) => g.label !== "Languages").flatMap((g) => g.items),
        knowsLanguage: ["English", "Spanish", "Latin", "Russian"],
        sameAs: [P.linkedin, P.personalSite, "https://github.com/TheBenMeadows"],
    };
}

function graph(page) {
    const nodes = [
        {
            "@type": "WebSite",
            "@id": `${ORIGIN}/#website`,
            url: `${ORIGIN}/`,
            name: P.name,
            inLanguage: "en-US",
            publisher: { "@id": `${ORIGIN}/#person` },
        },
        {
            "@type": page.path === "/" ? "ProfilePage" : "WebPage",
            "@id": `${ORIGIN}${page.path}#webpage`,
            url: `${ORIGIN}${page.path}`,
            name: page.title,
            description: page.description,
            isPartOf: { "@id": `${ORIGIN}/#website` },
            about: { "@id": `${ORIGIN}/#person` },
            dateModified: site.updated,
            ...(page.path === "/" ? { mainEntity: { "@id": `${ORIGIN}/#person` } } : {}),
        },
        page.path === "/" ? personLd() : { "@type": "Person", "@id": `${ORIGIN}/#person`, name: P.name, url: `${ORIGIN}/` },
    ];
    if (page.path !== "/" && !page.noindex) {
        nodes.push({
            "@type": "BreadcrumbList",
            itemListElement: [
                { "@type": "ListItem", position: 1, name: "Resume", item: `${ORIGIN}/` },
                { "@type": "ListItem", position: 2, name: page.nav, item: `${ORIGIN}${page.path}` },
            ],
        });
    }
    // "<" is escaped so no string in the data can close the script element.
    return JSON.stringify({ "@context": "https://schema.org", "@graph": nodes }, null, 1).replace(/</g, "\\u003c");
}

// ---------------------------------------------------------------- page shell

const NAV = [
    ["/", "Resume"],
    ["/recommendations/", "Recommendations"],
    ["/speaking/", "Speaking & side work"],
];

function layout(page, body) {
    const nav = NAV.map(
        ([path, label]) => `<a href="${path}"${path === page.path ? ' aria-current="page"' : ""}>${esc(label)}</a>`,
    ).join("");
    const robots = page.noindex ? '<meta name="robots" content="noindex" />' : "";
    const canonical = page.noindex ? "" : `<link rel="canonical" href="${ORIGIN}${page.path}" />`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(page.title)}</title>
<meta name="description" content="${esc(page.description)}" />
<meta name="author" content="${esc(P.name)}" />
<meta name="color-scheme" content="light dark" />
${robots}${canonical}
<meta property="og:type" content="${page.path === "/" ? "profile" : "website"}" />
<meta property="og:site_name" content="${esc(P.name)}" />
<meta property="og:title" content="${esc(page.title)}" />
<meta property="og:description" content="${esc(page.description)}" />
<meta property="og:url" content="${ORIGIN}${page.path}" />
<meta property="og:image" content="${ORIGIN}${asset("og.png")}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="${esc(P.name)}, ${esc(P.headline)}" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="preload" href="/fonts/publicsans-v1.woff2" as="font" type="font/woff2" crossorigin />
<link rel="stylesheet" href="/${CSS_NAME}" />
<script type="application/ld+json">${graph(page)}</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-head">
<a class="brand" href="/">${esc(P.name)}</a>
<nav aria-label="Site">${nav}</nav>
<form class="search" role="search" action="/search/" method="get">
<label class="vh" for="q">Search this site</label>
<input id="q" name="q" type="search" placeholder="Search" autocomplete="off" />
</form>
</header>
<main id="main">
${body}
</main>
<footer class="site-foot">
<p>For my art, software, and the rest of what I do outside of work, see <a href="${href(P.personalSite)}" rel="me">thebenmeadows.com</a>.</p>
<ul>
<li><a href="${href(`mailto:${P.email}`)}">Email me</a></li>
<li><a href="${href(P.linkedin)}" rel="me noopener">LinkedIn</a></li>
<li><a href="${href(P.source)}" rel="noopener">Site source</a></li>
</ul>
<p class="fine">Updated <time datetime="${site.updated}">${fmtDate(site.updated.slice(0, 7))}</time>.</p>
</footer>
<script src="/${JS_NAME}" defer></script>
</body>
</html>
`;
}

// ---------------------------------------------------------------- resume view

const bulletHtml = (b) => `<li>${b.lead ? `<strong>${esc(b.lead)}.</strong> ` : ""}${esc(b.text)}</li>`;

function roleHtml(r) {
    return `<article class="entry" id="${esc(r.id)}">
<p class="when">${esc(yearRange(r.start, r.end))}</p>
<div>
<h3>${esc(r.org)}${r.place ? ` <span class="place">${esc(r.place)}</span>` : ""}</h3>
<p class="title">${esc(r.title)}</p>
${r.titleNote ? `<p class="note">${esc(r.titleNote)}</p>` : ""}
${r.intro ? `<p>${esc(r.intro)}</p>` : ""}
<ul>${r.bullets.map(bulletHtml).join("\n")}</ul>
</div>
</article>`;
}

const simpleEntry = (id, when, heading, sub, text, extra = "") => `<article class="entry" id="${esc(id)}">
<p class="when">${esc(when)}</p>
<div>
<h3>${esc(heading)}</h3>
${sub ? `<p class="title">${esc(sub)}</p>` : ""}
${text ? `<p>${esc(text)}</p>` : ""}${extra}
</div>
</article>`;

function resumeHtml() {
    const edu = site.education.map((e) => simpleEntry(e.id, e.when, e.org, "", e.text)).join("\n");
    const creds = site.credentials
        .map(
            (g) => `<div class="entry"><p class="when">${esc(g.group)}</p><ul class="plain">${g.items
                .map((i) => {
                    const link = i.link ? ` <a href="${href(i.link)}" rel="noopener">${esc(i.linkText)}</a>` : "";
                    return `<li>${esc(i.text)} <span class="dim">${timeTag(i.date)}</span>${link}</li>`;
                })
                .join("")}</ul></div>`,
        )
        .join("\n");
    const aff = site.affiliations
        .map((a) => {
            const link = a.link ? ` <a href="${href(a.link)}" rel="noopener">${esc(a.linkText)}</a>` : "";
            const text = a.text ? `<p>${esc(a.text)}${link}</p>` : "";
            return simpleEntry(a.id, yearRange(a.start, a.end), a.org, a.role, "", text);
        })
        .join("\n");
    const skills = site.skills.groups
        .map((g) => `<div class="entry"><p class="when">${esc(g.label)}</p><p>${g.items.map(esc).join(", ")}</p></div>`)
        .join("\n");
    return `<div class="view view-resume">
<section aria-labelledby="h-results"><h2 id="h-results">Selected results</h2>
<ul class="results">${site.results.map(bulletHtml).join("\n")}</ul></section>
<section aria-labelledby="h-exp"><h2 id="h-exp">Experience</h2>
${site.roles.map(roleHtml).join("\n")}</section>
<section aria-labelledby="h-tech"><h2 id="h-tech">Technology</h2>
<ul class="results">${site.technology.items.map((t) => `<li>${esc(t)}</li>`).join("\n")}</ul></section>
<section aria-labelledby="h-edu"><h2 id="h-edu">Education</h2>
${edu}</section>
<section aria-labelledby="h-cred"><h2 id="h-cred">Licenses & certifications</h2>
${creds}</section>
<section aria-labelledby="h-aff"><h2 id="h-aff">Boards, memberships & service</h2>
${aff}</section>
<section aria-labelledby="h-skills"><h2 id="h-skills">Skills</h2>
${skills}</section>
</div>`;
}

// ---------------------------------------------------------------- timeline view

function timelineItems() {
    const items = [];
    for (const r of site.roles) {
        // After a promotion (startTitleEnd), the starting title's span stops there and
        // the later title is a milestone of its own.
        const end = r.startTitleEnd || r.end;
        items.push({ date: r.start, kind: "role", title: r.startTitle || r.title, org: r.org, span: fmtRange(r.start, end), summary: r.summary, href: `/#${r.id}` });
    }
    for (const e of site.education.filter((x) => x.date)) {
        items.push({ date: e.date, kind: "education", title: e.short || e.text, org: e.org, href: `/#${e.id}` });
    }
    for (const g of site.credentials) {
        for (const i of g.items) items.push({ date: i.date, kind: "credential", title: i.text, org: g.group });
    }
    for (const a of site.affiliations) {
        items.push({ date: a.start, kind: "board", title: a.short || a.role, org: a.org, span: fmtRange(a.start, a.end), summary: a.text, href: `/#${a.id}` });
    }
    for (const t of talks.speaking) {
        items.push({ date: t.date, kind: "speaking", title: t.title, org: t.venue, summary: t.kind, href: `/speaking/#${t.id}` });
    }
    items.push(...site.milestones);
    for (const it of items) {
        if (!/^\d{4}(-\d{2})?$/.test(it.date || "")) throw new Error(`timeline item "${it.title}" needs a date as YYYY or YYYY-MM`);
    }
    // Newest first by code point, so the order never depends on the build machine's
    // locale; ties keep their source order.
    return items
        .map((it, n) => ({ ...it, n }))
        .sort((a, b) => (sortKey(a.date) < sortKey(b.date) ? 1 : sortKey(a.date) > sortKey(b.date) ? -1 : a.n - b.n));
}

function timelineHtml() {
    const filters = KINDS.map(
        ([k, label]) => `<label><input type="checkbox" id="f-${k}" checked /> ${esc(label)}</label>`,
    ).join("\n");
    const rows = timelineItems()
        .map((it) => {
            const head = `<span class="t-title">${esc(it.title)}</span> <span class="t-org">${esc(it.org)}</span>`;
            const more = [
                it.span ? `<p class="dim">${esc(it.span)}</p>` : "",
                it.summary ? `<p>${esc(it.summary)}</p>` : "",
                it.href ? `<p><a href="${href(it.href)}">Details</a></p>` : "",
            ].join("");
            const body = more ? `<details><summary>${head}</summary>${more}</details>` : `<p class="t-flat">${head}</p>`;
            return `<li data-kind="${it.kind}"><p class="when">${timeTag(it.date)}</p>${body}</li>`;
        })
        .join("\n");
    return `<div class="view view-timeline">
<fieldset class="filters"><legend>Show</legend>
${filters}</fieldset>
<ol class="timeline">
${rows}
</ol>
</div>`;
}

// ---------------------------------------------------------------- pages

function indexPage() {
    const page = {
        path: "/",
        nav: "Resume",
        title: `${P.name} | ${P.headline}, Phoenix AZ`,
        description:
            "Benjamin Meadows: operations and sales executive in waterworks distribution, trade contracting, and commercial construction. Former VP, Internal Operations.",
    };
    const body = `<section class="intro with-photo">
<img class="headshot" src="${asset("headshot-320.jpg")}" srcset="${asset("headshot-320.jpg")} 320w, ${asset("headshot-640.jpg")} 640w" sizes="(max-width: 40rem) 6rem, 10rem" width="320" height="320" alt="${esc(P.name)}" fetchpriority="high" />
<div>
<h1>${esc(P.name)}</h1>
<p class="headline">${esc(P.headline)} <span class="dim">${esc(P.location)}</span></p>
${site.summary.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("\n")}
<p class="consulting">${esc(site.consulting.text)} <a href="${href(`mailto:${P.email}`)}">${esc(site.consulting.linkText || "Email me")}</a>.${site.consulting.after ? ` ${esc(site.consulting.after)}` : ""}</p>
</div>
</section>
<div class="views">
<input type="radio" name="view" id="view-resume" checked />
<input type="radio" name="view" id="view-timeline" />
<p class="switch"><label for="view-resume">Resume</label><label for="view-timeline">Timeline</label></p>
${resumeHtml()}
${timelineHtml()}
</div>`;
    return [page, body];
}

function recsPage() {
    const page = {
        path: "/recommendations/",
        nav: "Recommendations",
        title: `Recommendations | ${P.name}`,
        description:
            "Eight recommendations for Benjamin Meadows from people who reported to him, worked beside him, and sold to him at Gibson Plumbing and Fortiline Waterworks.",
    };
    const items = recs.items
        .map(
            (r) => `<figure class="rec" id="${esc(r.id)}">
<blockquote><p>${esc(r.text)}</p></blockquote>
<figcaption><strong>${esc(r.name)}</strong> <span class="dim">${esc(r.relationship)}${r.org ? `, ${esc(r.org)}` : ""}. ${timeTag(r.date)}</span></figcaption>
</figure>`,
        )
        .join("\n");
    const body = `<section class="intro">
<h1>Recommendations</h1>
<p>Eight recommendations, six of them from people who reported directly to me. They are reproduced in full from <a href="${href(P.linkedin)}" rel="noopener">my LinkedIn profile</a>, where each one can be checked against its author.</p>
</section>
${items}`;
    return [page, body];
}

function speakingPage() {
    const page = {
        path: "/speaking/",
        nav: "Speaking & side work",
        title: `Speaking & side work | ${P.name}`,
        description:
            "Talks and press featuring Benjamin Meadows, including the PHCC Construction Contractors' Alliance national meeting, and a short note on his art and technology work.",
    };
    const list = talks.speaking
        .map((t) => {
            const link = t.link ? ` <a href="${href(t.link)}" rel="noopener">${esc(t.linkText)}</a>` : "";
            return `<article class="entry" id="${esc(t.id)}">
<p class="when">${timeTag(t.date)}</p>
<div><h3>${esc(t.title)}</h3>
<p class="title">${esc(t.venue)}</p>
<p class="note">${esc(t.kind)}</p>
<p>${esc(t.text)}${link}</p></div>
</article>`;
        })
        .join("\n");
    const m = talks.speakingMore;
    const a = talks.artTech;
    const body = `<section class="intro">
<h1>Speaking & side work</h1>
<p>${esc(talks.intro.text)}</p>
</section>
<section aria-labelledby="h-talks"><h2 id="h-talks">Speaking & press</h2>
${list}
<p>${esc(m.text)} <a href="${href(m.link)}">${esc(m.linkText)}</a>.</p></section>
<section aria-labelledby="h-art"><h2 id="h-art">Art & technology</h2>
${a.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("\n")}
<p><a href="${href(a.link)}">${esc(a.linkText)}</a>.</p></section>`;
    return [page, body];
}

function searchPage() {
    const page = { path: "/search/", nav: "Search", title: `Search | ${P.name}`, description: "Search this site.", noindex: true };
    const body = `<section class="intro"><h1>Search</h1>
<p id="search-status" role="status">Type in the search box above.</p></section>
<ol id="search-results" class="results-list"></ol>
<noscript><p>Search needs JavaScript. Everything on this site is on three pages: <a href="/">Resume</a>, <a href="/recommendations/">Recommendations</a>, and <a href="/speaking/">Speaking & side work</a>.</p></noscript>`;
    return [page, body];
}

function notFoundPage() {
    const page = { path: "/404.html", nav: "Not found", title: `Page not found | ${P.name}`, description: "Page not found.", noindex: true };
    const body = `<section class="intro"><h1>Page not found</h1>
<p>Nothing lives at this address. Try the <a href="/">resume</a>, the <a href="/recommendations/">recommendations</a>, or <a href="/search/">search</a>.</p></section>`;
    return [page, body];
}

// ---------------------------------------------------------------- search index

function searchDocs() {
    const docs = [];
    const add = (url, title, section, text) => docs.push({ url, title, section, text });
    add("/", "Summary", "Resume", [...site.summary.paragraphs, site.consulting.text, site.consulting.after || ""].join(" "));
    add("/#h-results", "Selected results", "Resume", site.results.map((r) => `${r.lead ? `${r.lead}. ` : ""}${r.text}`).join(" "));
    for (const r of site.roles) {
        const text = [r.title, r.titleNote, r.place, r.intro, ...r.bullets.map((b) => `${b.lead || ""} ${b.text}`)];
        add(`/#${r.id}`, r.org, "Experience", text.filter(Boolean).join(" "));
    }
    add("/#h-tech", "Technology", "Resume", site.technology.items.join(" "));
    for (const e of site.education) add(`/#${e.id}`, e.org, "Education", e.text);
    for (const g of site.credentials) add("/#h-cred", g.group, "Licenses & certifications", g.items.map((i) => i.text).join(". "));
    for (const a of site.affiliations) add(`/#${a.id}`, a.org, "Boards, memberships & service", `${a.role} ${a.text}`);
    for (const g of site.skills.groups) add("/#h-skills", g.label, "Skills", g.items.join(", "));
    for (const r of recs.items) add(`/recommendations/#${r.id}`, r.name, "Recommendations", `${r.relationship} ${r.org} ${r.text}`);
    for (const t of talks.speaking) add(`/speaking/#${t.id}`, t.title, "Speaking & press", `${t.venue} ${t.kind} ${t.text}`);
    add("/speaking/#h-art", "Art & technology", "Speaking & side work", talks.artTech.paragraphs.join(" "));
    return docs;
}

// ---------------------------------------------------------------- output

function write(rel, body) {
    const out = join(DIST, rel);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, body);
}

function walk(dir) {
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : [full];
    });
}

function sitemap(pages) {
    const urls = pages
        .filter((p) => !p.noindex)
        .map((p) => `<url><loc>${ORIGIN}${p.path}</loc><lastmod>${site.updated}</lastmod></url>`)
        .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

// SHA-256 of every shipped file plus one tree hash, so a copy of the site served
// from anywhere can be checked against the build that produced it.
function manifest() {
    const files = {};
    for (const full of walk(DIST).sort()) {
        const rel = relative(DIST, full).split("\\").join("/");
        if (rel === "manifest.json") continue;
        files[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
    const tree = createHash("sha256");
    for (const [rel, sum] of Object.entries(files)) tree.update(`${sum}  ${rel}\n`);
    return JSON.stringify({ updated: site.updated, treeSha256: tree.digest("hex"), files }, null, 1) + "\n";
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync(join(ROOT, "static"), DIST, {
    recursive: true,
    filter: (src) => !src.endsWith(".DS_Store") && !(relative(join(ROOT, "static"), src) in HASHED),
});
for (const { body, name } of Object.values(HASHED)) write(name, body);

const built = [indexPage(), recsPage(), speakingPage(), searchPage(), notFoundPage()];
for (const [page, body] of built) {
    const rel = page.path.endsWith("/") ? `${page.path.slice(1)}index.html` : page.path.slice(1);
    write(rel, layout(page, body));
}
write("search-index.json", JSON.stringify({ docs: searchDocs() }));
write("sitemap.xml", sitemap(built.map(([p]) => p)));
write("robots.txt", `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
write("manifest.json", manifest());
console.log(`built ${built.length} pages, ${searchDocs().length} search entries -> dist/`);
