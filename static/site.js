/* Two small jobs, both optional: the pages read and navigate without this file.
 *   - format switch: keeps #timeline in the address so the timeline is linkable, and
 *     opens the resume when a link points at an entry inside it
 *   - search: /search/?q=... ranks entries from /search-index.json
 * No library, so `script-src 'self'` holds.
 */
(function () {
    var resume = document.getElementById("view-resume");
    var timeline = document.getElementById("view-timeline");

    function syncView() {
        if (!resume) return;
        var id = location.hash.slice(1);
        try {
            id = decodeURIComponent(id);
        } catch (e) {
            return;
        }
        if (id === "timeline") {
            timeline.checked = true;
            return;
        }
        var target = id && document.getElementById(id);
        if (target && target.closest(".view-resume")) {
            resume.checked = true;
            target.scrollIntoView();
        }
    }

    if (resume) {
        timeline.addEventListener("change", function () {
            history.replaceState(null, "", "#timeline");
        });
        resume.addEventListener("change", function () {
            history.replaceState(null, "", location.pathname);
        });
        window.addEventListener("hashchange", syncView);
        syncView();
    }

    var list = document.getElementById("search-results");
    if (!list) return;

    var status = document.getElementById("search-status");
    var input = document.getElementById("q");
    var docs = null;

    function tokenize(q) {
        return q.toLowerCase().split(/\s+/).filter(Boolean);
    }

    /* A hit in an entry's title counts for more than one in its body. Every word
       must match somewhere in the entry. */
    function score(doc, tokens) {
        var title = (doc.title + " " + doc.section).toLowerCase();
        var text = doc.text.toLowerCase();
        var total = 0;
        for (var i = 0; i < tokens.length; i++) {
            var inTitle = title.indexOf(tokens[i]) !== -1;
            var inText = text.indexOf(tokens[i]) !== -1;
            if (!inTitle && !inText) return 0;
            total += (inTitle ? 5 : 0) + (inText ? 1 : 0);
        }
        return total;
    }

    function snippet(text, tokens) {
        var lower = text.toLowerCase();
        var at = -1;
        for (var i = 0; i < tokens.length && at === -1; i++) at = lower.indexOf(tokens[i]);
        var start = Math.max(0, at - 70);
        var piece = text.slice(start, start + 220);
        return (start > 0 ? "… " : "") + piece + (start + 220 < text.length ? " …" : "");
    }

    /* Builds text nodes and <mark> elements rather than an HTML string, so nothing
       from the query or the index is ever parsed as markup. */
    function appendMarked(parent, text, tokens) {
        var lower = text.toLowerCase();
        var pos = 0;
        while (pos < text.length) {
            var next = -1;
            var len = 0;
            for (var i = 0; i < tokens.length; i++) {
                var at = lower.indexOf(tokens[i], pos);
                if (at !== -1 && (next === -1 || at < next)) {
                    next = at;
                    len = tokens[i].length;
                }
            }
            if (next === -1) break;
            parent.appendChild(document.createTextNode(text.slice(pos, next)));
            var mark = document.createElement("mark");
            mark.textContent = text.slice(next, next + len);
            parent.appendChild(mark);
            pos = next + len;
        }
        parent.appendChild(document.createTextNode(text.slice(pos)));
    }

    function render(q) {
        var tokens = tokenize(q);
        list.textContent = "";
        if (!tokens.length) {
            status.textContent = "Type in the search box above.";
            return;
        }
        var hits = [];
        for (var i = 0; i < docs.length; i++) {
            var s = score(docs[i], tokens);
            if (s) hits.push({ doc: docs[i], s: s, n: i });
        }
        hits.sort(function (a, b) {
            return b.s - a.s || a.n - b.n;
        });
        status.textContent = hits.length ? hits.length + (hits.length === 1 ? " result" : " results") + " for “" + q + "”" : "Nothing found for “" + q + "”.";
        hits.forEach(function (h) {
            var li = document.createElement("li");
            var a = document.createElement("a");
            a.href = h.doc.url;
            appendMarked(a, h.doc.title, tokens);
            var sec = document.createElement("span");
            sec.className = "dim";
            sec.textContent = "  " + h.doc.section;
            var p = document.createElement("p");
            appendMarked(p, snippet(h.doc.text, tokens), tokens);
            li.appendChild(a);
            li.appendChild(sec);
            li.appendChild(p);
            list.appendChild(li);
        });
    }

    var q = new URLSearchParams(location.search).get("q") || "";
    input.value = q;
    fetch("/search-index.json")
        .then(function (r) {
            if (!r.ok) throw new Error("index " + r.status);
            return r.json();
        })
        .then(function (data) {
            docs = data.docs;
            render(q);
            /* Waits for a pause in typing, so the status line is announced once per
               query and not once per keystroke. */
            var timer = null;
            input.addEventListener("input", function () {
                clearTimeout(timer);
                timer = setTimeout(function () {
                    history.replaceState(null, "", "?q=" + encodeURIComponent(input.value));
                    render(input.value);
                }, 250);
            });
        })
        .catch(function () {
            status.textContent = "Search could not load its index. Reload to try again.";
        });
})();
