# benjaminmeadows.com

Source for [benjaminmeadows.com](https://benjaminmeadows.com), the professional site of Benjamin Meadows: a resume in two formats, the recommendations he has received, and a short page on speaking and side work. His personal site is [thebenmeadows.com](https://thebenmeadows.com).

## Layout

- `content/` holds all of the copy as JSON. `site.json` is the resume, `recommendations.json` is the recommendations, and `speaking.json` is the speaking page.
- `static/` holds the stylesheet, the script, the font, the favicon, the share image, and the Cloudflare Pages `_headers` file.
- `build.mjs` renders `content/` and `static/` into `dist/`.
- `scripts/check-visibility.py` checks the built pages against a private fact base.

## Build

The build needs Node 20 or later and has no dependencies.

```
node build.mjs
```

The build reads no clock. Every date in the output comes from `content/`, so one commit always produces the same bytes. `dist/manifest.json` lists the SHA-256 of every file plus one tree hash, so a copy of the site can be checked against the build that made it.

To look at the result, serve `dist/` from any static server:

```
python3 -m http.server 8000 --directory dist
```

## Deploy

Cloudflare Pages builds this repository with the build command `node build.mjs` and the output directory `dist`.

## Editing the copy

Each item in `content/` has a `facts` list. The ids point into a fact base that is not in this repository, where every fact has a source and a visibility. An id that starts with `linkedin:` means that the text is already on the public LinkedIn profile.

After any change to `content/`, build the site and run the check:

```
node build.mjs
scripts/check-visibility.py
```

The check fails if an item cites no fact, cites a fact that is not public, or if the built pages contain a figure or wording that appears only in non-public facts. The check reads the fact base from `~/Projects/career/facts.json`. Use `--facts` to give it another path. It cannot run without the fact base, so it is not part of the Cloudflare build.

`content/site.json` has an `updated` date. Change it when the copy changes. The footer, the sitemap, and the structured data all read it.

## How the pages work

- The Resume and Timeline formats are two radio inputs and CSS. The timeline filters are checkboxes and `:has()`. Neither needs the script.
- `site.js` does two things. It keeps `#timeline` in the address so that the timeline can be linked, and it runs the search page against `search-index.json`.
- The Content-Security-Policy allows scripts and styles from this origin only. Do not add inline scripts or styles.
- The print stylesheet prints the resume format on its own.

## License

The code is under the MIT license. See `LICENSE`. The copy in `content/` is not: the recommendations belong to the people who wrote them, and the rest is © Benjamin Meadows. Public Sans is under the SIL Open Font License.
