/**
 * Recolour a github-profile-3d-contrib SVG so each day's block takes the colour
 * of the language written that day, and rebuild the pie chart from the same
 * data so the two agree.
 *
 * The action itself can't do this: its calendar data carries only a count and a
 * level per day, and its language data carries only repo totals with no dates.
 * Worse, `contributionsCollection` reports private work as an anonymous
 * `restrictedContributionsCount`, so ~2/3 of the calendar has no language at
 * all through that API. This walks the repos directly instead, which is why it
 * needs a token that can read them.
 *
 * Usage: GITHUB_TOKEN=... USERNAME=... node language-colors.mjs <path-to.svg>
 */

const TOKEN = process.env.GITHUB_TOKEN;
const USERNAME = process.env.USERNAME;
const SVG_PATH = process.argv[2];

if (!TOKEN || !USERNAME || !SVG_PATH) {
    console.error(
        'usage: GITHUB_TOKEN=... USERNAME=... node language-colors.mjs <svg>',
    );
    process.exit(1);
}

const OTHER_COLOR = '#444444';
const LEGEND_SLOTS = 6; // 5 languages + "other"; matches the action's layout
const PIE_OUTER = 117;
const PIE_INNER = 65;

/* ---------------------------------------------------------------- fetching */

async function graphql(query, variables = {}) {
    const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
            Authorization: `bearer ${TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
    });
    const body = await res.json();
    if (body.errors) {
        throw new Error(`GraphQL: ${JSON.stringify(body.errors)}`);
    }
    return body.data;
}

/** Ordered calendar days. No date args, so it matches what the action drew. */
async function fetchCalendar() {
    const data = await graphql(
        `query($login: String!) {
            user(login: $login) {
                contributionsCollection {
                    contributionCalendar {
                        weeks { contributionDays { date contributionLevel } }
                    }
                }
            }
        }`,
        { login: USERNAME },
    );
    const weeks =
        data.user.contributionsCollection.contributionCalendar.weeks;
    return weeks.flatMap((w) => w.contributionDays);
}

async function fetchRepos() {
    const repos = [];
    let cursor = null;
    for (;;) {
        const data = await graphql(
            `query($login: String!, $cursor: String) {
                user(login: $login) {
                    repositories(first: 100, after: $cursor, ownerAffiliations: OWNER) {
                        pageInfo { hasNextPage endCursor }
                        nodes {
                            nameWithOwner
                            pushedAt
                            isEmpty
                            primaryLanguage { name color }
                        }
                    }
                }
            }`,
            { login: USERNAME, cursor },
        );
        const page = data.user.repositories;
        repos.push(...page.nodes);
        if (!page.pageInfo.hasNextPage) break;
        cursor = page.pageInfo.endCursor;
    }
    return repos;
}

/**
 * Commit dates authored by USERNAME in [since, until], default branch.
 * The page cap only exists so a pathological repo can't spin forever — it sits
 * far above any real history (10k commits in one year from one author).
 */
async function fetchCommitDates(repo, since, until) {
    const dates = [];
    for (let page = 1; page <= 100; page++) {
        const url =
            `https://api.github.com/repos/${repo}/commits` +
            `?author=${encodeURIComponent(USERNAME)}` +
            `&since=${since}&until=${until}&per_page=100&page=${page}`;
        const res = await fetch(url, {
            headers: {
                Authorization: `bearer ${TOKEN}`,
                Accept: 'application/vnd.github+json',
            },
        });
        if (res.status === 409 || res.status === 404 || res.status === 403) {
            return dates; // empty repo, gone, or not visible to this token
        }
        if (!res.ok) {
            console.warn(`  ${repo}: HTTP ${res.status}, skipping`);
            return dates;
        }
        const commits = await res.json();
        if (!Array.isArray(commits) || commits.length === 0) break;
        for (const c of commits) {
            const d = c?.commit?.author?.date;
            if (d) dates.push(d.slice(0, 10));
        }
        if (commits.length < 100) break;
    }
    return dates;
}

/* ------------------------------------------------------------------ colour */

const hexToRgb = (hex) => {
    const h = hex.replace('#', '').trim();
    const full =
        h.length === 3
            ? h
                  .split('')
                  .map((c) => c + c)
                  .join('')
            : h;
    return [
        parseInt(full.slice(0, 2), 16),
        parseInt(full.slice(2, 4), 16),
        parseInt(full.slice(4, 6), 16),
    ];
};

const rgbToHex = (rgb) =>
    '#' +
    rgb
        .map((v) => Math.max(0, Math.min(255, Math.round(v))))
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('');

const mix = (hexA, hexB, t) => {
    const a = hexToRgb(hexA);
    const b = hexToRgb(hexB);
    return rgbToHex(a.map((v, i) => v + (b[i] - v) * t));
};

/** d3's .darker(k) — multiply channels by 0.7^k. Matches the action's shading. */
const darker = (hex, k) => rgbToHex(hexToRgb(hex).map((v) => v * 0.7 ** k));

const FACE_DARKEN = { top: 0, left: 0.5, right: 1 };

/** Level 1-4 ramps. Level 0 keeps the theme's empty-cell colour. */
const rampLight = (c) => [
    null,
    mix(c, '#ffffff', 0.7),
    mix(c, '#ffffff', 0.42),
    c,
    mix(c, '#000000', 0.24),
];
const rampDark = (c) => [
    null,
    mix(c, '#0d1117', 0.66),
    mix(c, '#0d1117', 0.36),
    c,
    mix(c, '#ffffff', 0.26),
];

const slugify = (name) =>
    name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

/* -------------------------------------------------------------- pie geometry */

/** Donut wedge from startAngle to endAngle (radians, 0 = 12 o'clock). */
function arcPath(startAngle, endAngle, outer, inner) {
    const f = (n) => Number(n.toFixed(3));
    const pt = (r, a) => [f(r * Math.sin(a)), f(-r * Math.cos(a))];
    const sweep = endAngle - startAngle;

    // A full circle can't be drawn as one arc — split it in two.
    if (sweep >= Math.PI * 2 - 1e-9) {
        const [ox, oy] = pt(outer, 0);
        const [ox2, oy2] = pt(outer, Math.PI);
        const [ix, iy] = pt(inner, 0);
        const [ix2, iy2] = pt(inner, Math.PI);
        return (
            `M${ox},${oy}A${outer},${outer},0,0,1,${ox2},${oy2}` +
            `A${outer},${outer},0,0,1,${ox},${oy}` +
            `M${ix},${iy}A${inner},${inner},0,0,0,${ix2},${iy2}` +
            `A${inner},${inner},0,0,0,${ix},${iy}Z`
        );
    }

    const large = sweep > Math.PI ? 1 : 0;
    const [x0, y0] = pt(outer, startAngle);
    const [x1, y1] = pt(outer, endAngle);
    const [x2, y2] = pt(inner, endAngle);
    const [x3, y3] = pt(inner, startAngle);
    return (
        `M${x0},${y0}A${outer},${outer},0,${large},1,${x1},${y1}` +
        `L${x2},${y2}A${inner},${inner},0,${large},0,${x3},${y3}Z`
    );
}

/* -------------------------------------------------------------------- main */

const esc = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function main() {
    const fs = await import('node:fs/promises');

    const days = await fetchCalendar();
    const since = `${days[0].date}T00:00:00Z`;
    const until = `${days[days.length - 1].date}T23:59:59Z`;
    console.log(`calendar: ${days.length} days, ${days[0].date} → ${days[days.length - 1].date}`);

    const repos = await fetchRepos();
    const inWindow = repos.filter(
        (r) => !r.isEmpty && r.pushedAt && r.pushedAt >= since,
    );
    console.log(`repos: ${repos.length} owned, ${inWindow.length} pushed in window`);

    // language name -> colour, taken from GitHub's own linguist palette so the
    // calendar and the pie draw from one source
    const langColor = new Map();
    for (const r of repos) {
        const l = r.primaryLanguage;
        if (l?.name && l.color) langColor.set(l.name, l.color);
    }

    const perDay = new Map(); // date -> {lang: commits}
    const totals = new Map(); // lang -> commits
    for (const r of inWindow) {
        const lang = r.primaryLanguage?.name ?? null;
        const dates = await fetchCommitDates(r.nameWithOwner, since, until);
        for (const date of dates) {
            const key = lang ?? '__unknown__';
            if (!perDay.has(date)) perDay.set(date, new Map());
            const m = perDay.get(date);
            m.set(key, (m.get(key) ?? 0) + 1);
            totals.set(key, (totals.get(key) ?? 0) + 1);
        }
    }

    const dominant = new Map(); // date -> language name
    for (const [date, m] of perDay) {
        const [best] = [...m.entries()]
            .filter(([k]) => k !== '__unknown__')
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        if (best) dominant.set(date, best[0]);
    }

    const active = days.filter((d) => d.contributionLevel !== 'NONE');
    const covered = active.filter((d) => dominant.has(d.date));
    const pct = Math.round((100 * covered.length) / active.length);
    console.log(`coverage: ${covered.length}/${active.length} active days (${pct}%)`);

    if (pct < 50) {
        console.warn(
            `::warning::Only ${pct}% of active days got a language. The token ` +
                `likely can't read your other repos — set PROFILE_PAT to a ` +
                `classic PAT with the 'repo' scope.`,
        );
    }

    /* ---- rewrite the calendar blocks ---- */

    let svg = await fs.readFile(SVG_PATH, 'utf8');

    const LEVEL_INDEX = {
        NONE: 0,
        FIRST_QUARTILE: 1,
        SECOND_QUARTILE: 2,
        THIRD_QUARTILE: 3,
        FOURTH_QUARTILE: 4,
    };

    const used = new Set(); // "lang|level"
    const counters = { top: 0, left: 0, right: 0 };

    svg = svg.replace(
        /class="cont-(top|left|right)-([0-4])"/g,
        (whole, face, levelStr) => {
            const idx = counters[face]++;
            const day = days[idx];
            if (!day) return whole; // more rects than days: leave alone
            const level = LEVEL_INDEX[day.contributionLevel];
            if (level !== Number(levelStr)) return whole; // desync: bail safely
            if (level === 0) return whole; // empty day keeps the theme colour
            const lang = dominant.get(day.date);
            if (!lang || !langColor.has(lang)) return whole;
            used.add(`${lang}|${level}`);
            return `class="lg-${slugify(lang)}-${face}-${level}"`;
        },
    );

    if (counters.top !== days.length) {
        console.warn(
            `warning: ${counters.top} block groups vs ${days.length} calendar days`,
        );
    }

    /* ---- inject the language CSS ---- */

    const rulesFor = (ramp) => {
        const out = [];
        for (const key of used) {
            const [lang, levelStr] = key.split('|');
            const level = Number(levelStr);
            const base = ramp(langColor.get(lang))[level];
            for (const [face, k] of Object.entries(FACE_DARKEN)) {
                out.push(
                    `.lg-${slugify(lang)}-${face}-${level}{fill:${darker(base, k)};}`,
                );
            }
        }
        return out.join('\n');
    };

    const css =
        `\n/* language colours */\n${rulesFor(rampLight)}\n` +
        `@media (prefers-color-scheme: dark) {\n${rulesFor(rampDark)}\n}\n`;

    const styleEnd = svg.lastIndexOf('</style>');
    if (styleEnd < 0) throw new Error('no </style> in SVG');
    svg = svg.slice(0, styleEnd) + css + svg.slice(styleEnd);

    /* ---- rebuild the pie from the same totals ---- */

    const ranked = [...totals.entries()]
        .filter(([k]) => k !== '__unknown__' && langColor.has(k))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    const top = ranked.slice(0, LEGEND_SLOTS - 1);
    const otherTotal =
        ranked.slice(LEGEND_SLOTS - 1).reduce((a, [, v]) => a + v, 0) +
        (totals.get('__unknown__') ?? 0);
    const slices = [...top];
    if (otherTotal > 0) slices.push(['other', otherTotal]);

    const grand = slices.reduce((a, [, v]) => a + v, 0);
    if (grand > 0) {
        const colorOf = (name) =>
            name === 'other' ? OTHER_COLOR : langColor.get(name);

        // arcs, in document order
        let angle = 0;
        const arcs = slices.map(([name, value]) => {
            const start = angle;
            angle += (value / grand) * Math.PI * 2;
            return {
                name,
                value,
                d: arcPath(start, angle, PIE_OUTER, PIE_INNER),
                fill: colorOf(name),
            };
        });

        let arcSeen = 0;
        svg = svg.replace(
            /<path d="[^"]*" style="fill: [^"]*;" class="stroke-bg" stroke-width="2px"><title>[^<]*<\/title>/g,
            (whole) => {
                const a = arcs[arcSeen++];
                if (!a) return `<path d="" style="fill: none;" class="stroke-bg" stroke-width="2px"><title></title>`;
                return (
                    `<path d="${a.d}" style="fill: ${a.fill};" ` +
                    `class="stroke-bg" stroke-width="2px">` +
                    `<title>${esc(a.name)} ${a.value}</title>`
                );
            },
        );

        // legend swatches keep their geometry; only the fill changes
        let swatchSeen = 0;
        svg = svg.replace(
            /(<rect x="0" y="[\d.]+" width="[\d.]+" height="[\d.]+" fill=")#[0-9A-Fa-f]{3,6}(")/g,
            (whole, head, tail) => {
                const a = arcs[swatchSeen++];
                return a ? `${head}${a.fill}${tail}` : `${head}none${tail}`;
            },
        );

        // legend labels: text node sits before a nested <animate>
        let labelSeen = 0;
        svg = svg.replace(
            /(<text dominant-baseline="middle" x="26" y="[\d.]+" class="fill-fg" font-size="[\d.]+px">)[^<]*/g,
            (whole, head) => {
                const a = arcs[labelSeen++];
                return a ? `${head}${esc(a.name)}` : head;
            },
        );

        console.log(
            `pie: ${arcSeen} arcs, ${swatchSeen} swatches, ${labelSeen} labels — ` +
                slices.map(([n, v]) => `${n} ${v}`).join(', '),
        );
    }

    await fs.writeFile(SVG_PATH, svg);
    console.log(`wrote ${SVG_PATH}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
