#!/usr/bin/env node
/**
 * generate-profile.mjs
 * ---------------------------------------------------------------
 * Zero-dependency generator for a "developer control center" style
 * GitHub profile terminal.
 *
 * - Uses only Node.js built-ins (fetch, fs, path). No npm packages.
 * - Reads live, public data from the GitHub REST API.
 * - Uses GITHUB_TOKEN when available (higher rate limits), but NEVER
 *   requires it and NEVER hardcodes a secret.
 * - Explicitly filters out any repository where `private !== false`,
 *   as defense-in-depth against ever rendering private-repo data,
 *   even though the endpoint used here is public-only by design.
 * - Never fabricates numbers. Core profile data (user + repos)
 *   failing to fetch is FATAL (non-zero exit) — no fake/stale card
 *   is ever written. The recent-activity feed is best-effort and
 *   degrades to an honest "unavailable" line rather than failing
 *   the whole build, since it's a nice-to-have, not core identity.
 * - The SVG uses no <script>, no SMIL/CSS animation, no external
 *   fonts, and no external image references — only inline shapes
 *   and text in a generic monospace font stack — so it renders
 *   identically wherever GitHub displays it, including through
 *   its image proxy and on mobile.
 * ---------------------------------------------------------------
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(REPO_ROOT, "assets", "terminal.svg");

// ---------------------------------------------------------------
// Configuration (static profile facts — not fetched, not secret)
// ---------------------------------------------------------------
const CONFIG = {
  username: process.env.GITHUB_USERNAME || "emirarnautovic83-cmd",
  name: "Emir Arnautovic",
  role: "Full Stack SaaS Developer",
  studio: "EA SaaS Studio",
  focus: "SaaS · AI Systems · Automation",
  status: "Open to collaboration",
  website: "https://easaas.studio",
  stack: [
    "React",
    "TypeScript",
    "Supabase",
    "PostgreSQL",
    "n8n",
    "OpenAI",
    "Lovable",
    "Tailwind",
    "Vercel",
  ],
  building: [
    "AI agents for real business workflows",
    "SaaS products from prototype to launch",
    "Automation systems that remove manual work",
  ],
};

const API_BASE = "https://api.github.com";
const USER_AGENT = "ea-saas-studio-profile-generator";

// ---------------------------------------------------------------
// HTTP helper — retries transient failures, never fakes a response
// ---------------------------------------------------------------
async function githubFetch(pathAndQuery, { retries = 2 } = {}) {
  const url = `${API_BASE}${pathAndQuery}`;
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers });

      if (res.status === 403 || res.status === 429) {
        const remaining = res.headers.get("x-ratelimit-remaining");
        const reset = res.headers.get("x-ratelimit-reset");
        throw new Error(
          `GitHub API rate-limited (status ${res.status}, remaining=${remaining}, reset=${reset}) for ${url}`
        );
      }
      if (!res.ok) {
        throw new Error(`GitHub API error ${res.status} ${res.statusText} for ${url}`);
      }
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------
async function fetchUser(username) {
  return githubFetch(`/users/${encodeURIComponent(username)}`);
}

async function fetchPublicRepos(username) {
  // /users/{username}/repos returns ONLY that user's public
  // repositories, regardless of the token used to authenticate the
  // request. This is distinct from /user/repos (authenticated-user
  // scoped, can include private repos) — that endpoint is
  // deliberately never called here.
  const perPage = 100;
  let page = 1;
  const all = [];

  while (true) {
    const batch = await githubFetch(
      `/users/${encodeURIComponent(username)}/repos?per_page=${perPage}&page=${page}&type=owner`
    );
    all.push(...batch);
    if (batch.length < perPage) break;
    page += 1;
    if (page > 10) break; // hard safety cap (1000 repos)
  }

  // Defense-in-depth: never trust a single filter.
  return all.filter((repo) => repo.private === false);
}

async function fetchRecentPublicEvents(username) {
  // Best-effort. If this fails or is empty, the activity feed just
  // says so honestly — it does not block the rest of the card.
  try {
    const events = await githubFetch(
      `/users/${encodeURIComponent(username)}/events/public?per_page=10`,
      { retries: 1 }
    );
    return Array.isArray(events) ? events : [];
  } catch (err) {
    console.warn("[generate-profile] Recent activity unavailable:", err.message);
    return null; // null = "couldn't check", distinct from [] = "checked, nothing there"
  }
}

// ---------------------------------------------------------------
// Stats computation
// ---------------------------------------------------------------
function relativeTime(iso) {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - then) / 1000));

  const units = [
    ["y", 31536000],
    ["mo", 2592000],
    ["w", 604800],
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
  ];
  for (const [label, secs] of units) {
    const value = Math.floor(diffSec / secs);
    if (value >= 1) return `${value}${label} ago`;
  }
  return "just now";
}

function describeEvent(event) {
  const repo = event.repo?.name?.split("/")?.[1] || event.repo?.name || "a repo";
  const when = relativeTime(event.created_at);
  switch (event.type) {
    case "PushEvent": {
      const n = event.payload?.commits?.length ?? 0;
      const noun = n === 1 ? "commit" : "commits";
      return n > 0 ? `Pushed ${n} ${noun} to ${repo} · ${when}` : `Pushed to ${repo} · ${when}`;
    }
    case "PullRequestEvent":
      return `${event.payload?.action === "closed" ? "Merged" : "Opened"} a PR in ${repo} · ${when}`;
    case "IssuesEvent":
      return `${event.payload?.action === "closed" ? "Closed" : "Opened"} an issue in ${repo} · ${when}`;
    case "CreateEvent":
      return `Created ${event.payload?.ref_type || "a ref"} in ${repo} · ${when}`;
    case "WatchEvent":
      return `Starred ${repo} · ${when}`;
    case "ForkEvent":
      return `Forked ${repo} · ${when}`;
    case "IssueCommentEvent":
      return `Commented in ${repo} · ${when}`;
    case "PullRequestReviewEvent":
      return `Reviewed a PR in ${repo} · ${when}`;
    case "ReleaseEvent":
      return `Published a release in ${repo} · ${when}`;
    default:
      return `Active in ${repo} · ${when}`;
  }
}

function computeStats(user, repos, events) {
  // The profile repo itself (username/username) isn't a "project" —
  // excluding it from aggregate stats makes them more meaningful.
  // It's a curation choice, not a fabrication: every number below
  // is still built only from real, live public data.
  const projectRepos = repos.filter(
    (r) => r.name.toLowerCase() !== user.login.toLowerCase()
  );

  const totalStars = repos.reduce((sum, r) => sum + (r.stargazers_count || 0), 0);

  const recentlyUpdated = [...projectRepos]
    .filter((r) => r.pushed_at)
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
    .slice(0, 2)
    .map((r) => ({ name: r.name, when: relativeTime(r.pushed_at) }));

  let lastActivity;
  if (events === null) {
    lastActivity = { available: false, text: "temporarily unavailable" };
  } else if (events.length === 0) {
    lastActivity = { available: true, text: "no recent public activity" };
  } else {
    lastActivity = { available: true, text: describeEvent(events[0]) };
  }

  return {
    publicRepos: user.public_repos ?? repos.length,
    followers: user.followers ?? null,
    totalStars,
    recentlyUpdated,
    lastActivity,
  };
}

// ---------------------------------------------------------------
// Tiny SVG layout engine
// ---------------------------------------------------------------
const FONT = "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace";
const COLORS = {
  bg: "#0a0e14",
  panel: "#0d1219",
  border: "#1b2430",
  borderSoft: "#161d27",
  text: "#c9d1d9",
  textDim: "#6b7685",
  textFaint: "#454e5c",
  accent: "#3fd0ff",
  accentDim: "#1c6e85",
  green: "#3fb950",
  white: "#e6edf3",
};

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Approximate advance width (px) of one monospace glyph at a given
// font-size. Used only to size boxes/chips so nothing clips or
// overlaps — not for exact glyph-level typesetting.
const MONO_RATIO = 0.6;
function textWidth(str, fontSize) {
  return str.length * fontSize * MONO_RATIO;
}

/**
 * Truncates a string with an ellipsis so it never exceeds maxWidth
 * at the given font size. This is the safety net for any value that
 * ultimately comes from live API data (repo names, commit counts,
 * event descriptions) — those have no fixed length, so overlap or
 * clipping is only prevented by measuring, never by assuming.
 */
function truncateToWidth(str, maxWidth, fontSize) {
  if (textWidth(str, fontSize) <= maxWidth) return str;
  let s = str;
  while (s.length > 1 && textWidth(s + "…", fontSize) > maxWidth) {
    s = s.slice(0, -1);
  }
  return s + "…";
}

/** Collects SVG fragments. */
function createLayer() {
  const parts = [];
  return {
    push(svg) {
      parts.push(svg);
    },
    toString() {
      return parts.join("\n");
    },
  };
}

function text(x, y, str, { size = 13, color = COLORS.text, weight = "normal", anchor = "start", letterSpacing } = {}) {
  const ls = letterSpacing ? ` letter-spacing="${letterSpacing}"` : "";
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}"${ls} xml:space="preserve">${escapeXml(
    str
  )}</text>`;
}

function sectionHeader(layer, x, y, index, label, colWidth) {
  layer.push(text(x, y, String(index).padStart(2, "0"), { size: 11, color: COLORS.accentDim, weight: "bold" }));
  layer.push(text(x + 26, y, label, { size: 12.5, color: COLORS.accent, weight: "bold", letterSpacing: "1.2" }));
  layer.push(
    `<line x1="${x + 26 + textWidth(label, 12.5) + 12}" y1="${y - 4}" x2="${x + colWidth}" y2="${y - 4}" stroke="${
      COLORS.borderSoft
    }" stroke-width="1"/>`
  );
  return y + 22;
}

function keyValueRow(layer, x, y, label, value, labelWidth, maxValueWidth) {
  layer.push(text(x, y, label, { size: 13, color: COLORS.textDim }));
  const safeValue = maxValueWidth ? truncateToWidth(value, maxValueWidth, 13) : value;
  layer.push(text(x + labelWidth, y, safeValue, { size: 13, color: COLORS.white }));
  return y + 21;
}

/** Same as keyValueRow, but for a label with several stacked values
 * (e.g. multiple recently-updated repos) — each on its own line, so
 * a long list never has to be crammed into one overflowing row. */
function keyValueListRow(layer, x, y, label, values, labelWidth, maxValueWidth) {
  layer.push(text(x, y, label, { size: 13, color: COLORS.textDim }));
  for (const value of values) {
    const safeValue = truncateToWidth(value, maxValueWidth, 13);
    layer.push(text(x + labelWidth, y, safeValue, { size: 13, color: COLORS.white }));
    y += 21;
  }
  return y;
}

/** Wraps chip tokens across colWidth, returns new y after the block. */
function chipGrid(layer, x, y, items, colWidth) {
  const paddingX = 12;
  const gap = 8;
  const rowHeight = 26;
  let cursorX = x;
  let cursorY = y;

  for (const item of items) {
    const w = textWidth(item, 12) + paddingX * 2;
    if (cursorX + w > x + colWidth && cursorX !== x) {
      cursorX = x;
      cursorY += rowHeight + gap;
    }
    layer.push(
      `<rect x="${cursorX}" y="${cursorY}" width="${w}" height="${rowHeight}" rx="5" fill="${COLORS.panel}" stroke="${COLORS.border}" stroke-width="1"/>`
    );
    layer.push(
      text(cursorX + w / 2, cursorY + rowHeight / 2 + 4.5, item, { size: 12, color: COLORS.text, anchor: "middle" })
    );
    cursorX += w + gap;
  }
  return cursorY + rowHeight;
}

function tag(layer, x, y, label, { color = COLORS.accent, dot = true } = {}) {
  const padX = 10;
  const h = 24;
  const dotSpace = dot ? 14 : 0;
  const w = textWidth(label, 11) + padX * 2 + dotSpace;
  layer.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="none" stroke="${COLORS.border}" stroke-width="1"/>`);
  if (dot) {
    layer.push(`<circle cx="${x + padX + 3}" cy="${y + h / 2}" r="3" fill="${color}"/>`);
  }
  layer.push(text(x + padX + dotSpace, y + h / 2 + 4, label, { size: 11, color, letterSpacing: "0.6" }));
  return { height: h, width: w };
}

// ---------------------------------------------------------------
// Full SVG assembly
// ---------------------------------------------------------------
function renderSVG(stats) {
  const WIDTH = 900;
  const PAD = 28;
  const LEFT_COL_W = 220;
  const GUTTER = 32;
  const RIGHT_COL_X = PAD + LEFT_COL_W + GUTTER;
  const RIGHT_COL_W = WIDTH - RIGHT_COL_X - PAD;
  const HEADER_H = 56;

  const body = createLayer();

  // ---- LEFT COLUMN: identity block ----
  let ly = HEADER_H + PAD + 8;
  const leftX = PAD;

  body.push(
    `<rect x="${leftX}" y="${ly}" width="140" height="86" rx="8" fill="${COLORS.panel}" stroke="${COLORS.border}" stroke-width="1"/>`
  );
  body.push(text(leftX + 20, ly + 40, "E A", { size: 30, color: COLORS.accent, weight: "bold", letterSpacing: "4" }));
  body.push(text(leftX + 20, ly + 64, "SAAS STUDIO", { size: 10, color: COLORS.textDim, letterSpacing: "2" }));
  ly += 86 + 22;

  const tags = ["SYSTEM ONLINE", "API CONNECTED", "BUILDING..."];
  const tagColors = [COLORS.green, COLORS.accent, COLORS.textDim];
  for (let i = 0; i < tags.length; i++) {
    const { height } = tag(body, leftX, ly, tags[i], { color: tagColors[i] });
    ly += height + 10;
  }

  ly += 10;
  body.push(text(leftX, ly, "> AI agents", { size: 11.5, color: COLORS.textFaint }));
  ly += 18;
  body.push(text(leftX, ly, "> SaaS systems", { size: 11.5, color: COLORS.textFaint }));
  ly += 18;
  body.push(text(leftX, ly, "> automation", { size: 11.5, color: COLORS.textFaint }));
  ly += 18;

  const leftColumnBottom = ly;

  // ---- RIGHT COLUMN: dashboard sections ----
  let ry = HEADER_H + PAD + 16;
  const rx = RIGHT_COL_X;

  // Every label used across the two key/value sections shares one
  // column width, computed from the longest label rather than
  // guessed — this is what guarantees "Recently updated" can never
  // collide with its value.
  const ALL_LABELS = [
    "Name",
    "Role",
    "Studio",
    "Focus",
    "Status",
    "Public repos",
    "Followers",
    "Last activity",
    "Recently updated",
  ];
  const labelWidth = Math.ceil(Math.max(...ALL_LABELS.map((l) => textWidth(l, 13)))) + 20;
  const valueMaxWidth = RIGHT_COL_W - labelWidth - 4;

  // 01 SYSTEM.INFO
  ry = sectionHeader(body, rx, ry, 1, "SYSTEM.INFO", RIGHT_COL_W);
  ry += 6;
  ry = keyValueRow(body, rx, ry, "Name", CONFIG.name, labelWidth, valueMaxWidth);
  ry = keyValueRow(body, rx, ry, "Role", CONFIG.role, labelWidth, valueMaxWidth);
  ry = keyValueRow(body, rx, ry, "Studio", CONFIG.studio, labelWidth, valueMaxWidth);
  ry = keyValueRow(body, rx, ry, "Focus", CONFIG.focus, labelWidth, valueMaxWidth);
  ry = keyValueRow(body, rx, ry, "Status", CONFIG.status, labelWidth, valueMaxWidth);
  ry += 20;

  // 02 TECH.STACK
  ry = sectionHeader(body, rx, ry, 2, "TECH.STACK", RIGHT_COL_W);
  ry += 4;
  ry = chipGrid(body, rx, ry, CONFIG.stack, RIGHT_COL_W);
  ry += 28;

  // 03 GITHUB.LIVE — every value here ultimately traces back to a
  // live API response, so each one goes through the same width-safe
  // rendering path as the static fields above.
  ry = sectionHeader(body, rx, ry, 3, "GITHUB.LIVE", RIGHT_COL_W);
  ry += 6;
  ry = keyValueRow(body, rx, ry, "Public repos", String(stats.publicRepos), labelWidth, valueMaxWidth);
  ry = keyValueRow(body, rx, ry, "Followers", String(stats.followers ?? "—"), labelWidth, valueMaxWidth);
  ry = keyValueRow(body, rx, ry, "Last activity", stats.lastActivity.text, labelWidth, valueMaxWidth);
  if (stats.recentlyUpdated.length > 0) {
    const updatedLines = stats.recentlyUpdated.map((r) => `${r.name} · ${r.when}`);
    ry = keyValueListRow(body, rx, ry, "Recently updated", updatedLines, labelWidth, valueMaxWidth);
  }
  ry += 20;

  // 04 CURRENTLY.BUILDING
  ry = sectionHeader(body, rx, ry, 4, "CURRENTLY.BUILDING", RIGHT_COL_W);
  ry += 6;
  for (const line of CONFIG.building) {
    body.push(text(rx, ry, `>`, { size: 13, color: COLORS.accent }));
    body.push(text(rx + 18, ry, line, { size: 13, color: COLORS.text }));
    ry += 21;
  }

  const rightColumnBottom = ry;
  const contentBottom = Math.max(leftColumnBottom, rightColumnBottom);
  const FOOTER_H = 40;
  const HEIGHT = contentBottom + PAD + FOOTER_H;

  // ---- Chrome: outer frame, header bar, footer ----
  const chrome = createLayer();
  chrome.push(
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" rx="12" fill="${COLORS.bg}" stroke="${COLORS.border}" stroke-width="1"/>`
  );
  chrome.push(`<rect x="0" y="0" width="${WIDTH}" height="${HEADER_H}" rx="12" fill="${COLORS.panel}"/>`);
  chrome.push(`<rect x="0" y="${HEADER_H - 12}" width="${WIDTH}" height="12" fill="${COLORS.panel}"/>`);
  chrome.push(`<line x1="0" y1="${HEADER_H}" x2="${WIDTH}" y2="${HEADER_H}" stroke="${COLORS.border}" stroke-width="1"/>`);

  chrome.push(`<circle cx="26" cy="${HEADER_H / 2}" r="4.5" fill="${COLORS.textFaint}"/>`);
  chrome.push(`<circle cx="42" cy="${HEADER_H / 2}" r="4.5" fill="${COLORS.textFaint}"/>`);
  chrome.push(`<circle cx="58" cy="${HEADER_H / 2}" r="4.5" fill="${COLORS.textFaint}"/>`);

  chrome.push(text(80, HEADER_H / 2 - 5, "emir@github", { size: 13.5, color: COLORS.green, weight: "bold" }));
  chrome.push(text(80, HEADER_H / 2 + 13, "~ ./profile.sh --live", { size: 12, color: COLORS.textDim }));

  const onlineLabel = "ONLINE";
  const onlineTagW = textWidth(onlineLabel, 11) + 34;
  const onlineTagX = WIDTH - PAD - onlineTagW;
  chrome.push(
    `<rect x="${onlineTagX}" y="${HEADER_H / 2 - 12}" width="${onlineTagW}" height="24" rx="4" fill="none" stroke="${COLORS.accentDim}" stroke-width="1"/>`
  );
  chrome.push(`<circle cx="${onlineTagX + 14}" cy="${HEADER_H / 2}" r="3" fill="${COLORS.accent}"/>`);
  chrome.push(text(onlineTagX + 26, HEADER_H / 2 + 4, onlineLabel, { size: 11, color: COLORS.accent, letterSpacing: "1" }));

  const dividerX = PAD + LEFT_COL_W + GUTTER / 2;
  chrome.push(
    `<line x1="${dividerX}" y1="${HEADER_H + PAD}" x2="${dividerX}" y2="${contentBottom}" stroke="${COLORS.borderSoft}" stroke-width="1"/>`
  );

  const footerY = HEIGHT - FOOTER_H / 2;
  chrome.push(
    `<line x1="0" y1="${HEIGHT - FOOTER_H}" x2="${WIDTH}" y2="${HEIGHT - FOOTER_H}" stroke="${COLORS.border}" stroke-width="1"/>`
  );
  chrome.push(text(PAD, footerY + 4, "01  02  03  04", { size: 10.5, color: COLORS.textFaint, letterSpacing: "2" }));
  chrome.push(
    text(WIDTH - PAD, footerY + 4, `synced ${new Date().toISOString().slice(0, 10)} _`, {
      size: 10.5,
      color: COLORS.textFaint,
      anchor: "end",
      letterSpacing: "0.5",
    })
  );

  return `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg" xml:space="preserve" role="img" aria-label="Live developer control-center profile card for ${escapeXml(
    CONFIG.username
  )}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${COLORS.bg}"/>
  ${chrome.toString()}
  ${body.toString()}
</svg>
`;
}

// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------
async function main() {
  const username = CONFIG.username;
  console.log(`[generate-profile] Fetching live data for ${username}...`);

  const user = await fetchUser(username);
  const repos = await fetchPublicRepos(username);
  const events = await fetchRecentPublicEvents(username);
  const stats = computeStats(user, repos, events);

  console.log("[generate-profile] Computed stats:", stats);

  const svg = renderSVG(stats);

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, svg, "utf8");

  console.log(`[generate-profile] Wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
}

main().catch((err) => {
  console.error("[generate-profile] FAILED — no output was faked or reused silently.");
  console.error(err);
  process.exit(1);
});
