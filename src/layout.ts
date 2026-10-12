/**
 * The one page layout every server-rendered page uses, here and in githug.ai's site: the head
 * boilerplate, the brand tokens (one mono family, forest ground, green = agent, coral = human)
 * and an optional first-party beacon. A page passes its title, its own CSS and its body;
 * change the brand here and every page follows.
 */
import { escapeHtml } from "./render.js";

/** Geist Mono, preconnected. */
export const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&display=swap"/>`;

/**
 * Brand tokens, dark first, light by preference. --coral is the brand coral for fills and
 * borders; --coral-text is the coral to set text in (darker in light mode, for contrast).
 */
export const TOKENS_CSS = `:root{
  color-scheme:dark;
  --bg:#0f1a14;--raise:#14211a;--fg:#e8eee9;--mute:#93a39a;--faint:#24342b;--green:#5fb27f;--coral:#f26b4f;--coral-text:#f26b4f;--on-green:#0f1a14;
  --mono:"Geist Mono",ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:light){:root{
  color-scheme:light;
  --bg:#f6f8f5;--raise:#ffffff;--fg:#0f1a14;--mute:#5b6b62;--faint:#dbe3de;--green:#2f7d4f;--coral-text:#c94a2e;--on-green:#ffffff;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--mono)}
`;

/** The dashboard's UI kit (nav, headings, lists, buttons, forms), shared by core's own pages. */
export const UI_CSS = `
body{font:14px/1.6 var(--mono)}
.wrap{max-width:880px;margin:0 auto;padding:24px 16px 64px}
.nav{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:40px}
.wm{color:var(--fg);font-weight:600;text-decoration:none}
.who{color:var(--mute)}.who b{color:var(--coral-text);font-weight:500}
.who a{color:var(--mute);margin-left:12px}
h1{font-size:22px;font-weight:600;margin:0 0 8px}
.lede{color:var(--mute);margin:0 0 28px}
.agents{list-style:none;margin:0;padding:0;border-top:1px solid var(--faint)}
.agents li{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 0;border-bottom:1px solid var(--faint)}
.agents .id{color:var(--green);font-weight:500}
.agents .meta{color:var(--mute);overflow-wrap:anywhere}
.off{color:var(--coral-text)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.empty{color:var(--mute);border:1px dashed var(--faint);padding:20px;border-radius:6px}
h2{font-size:15px;font-weight:600;margin:40px 0 12px}
.btn{display:inline-block;font:inherit;font-size:13px;padding:6px 12px;border-radius:6px;border:1px solid var(--faint);background:var(--raise);color:var(--fg);text-decoration:none;cursor:pointer}
.btn.go{background:var(--green);border-color:var(--green);color:var(--bg)}
.inline{display:inline;margin:0}
form.new{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
form.new input,form.new select{font:inherit;font-size:13px;padding:6px 10px;border-radius:6px;border:1px solid var(--faint);background:var(--raise);color:var(--fg);min-width:0;max-width:100%}
.hint{color:var(--mute);font-size:12px;margin:8px 0 0}
.err{color:var(--coral-text);margin:0 0 20px}
.key{border:1px solid var(--green);border-radius:6px;padding:16px;margin:0 0 28px}
.key pre{margin:8px 0;padding:10px;background:var(--raise);border-radius:4px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
`;

/** Turned on by an instance that collects first-party beacons at POST /api/evt (githug.ai's site does). */
export const layoutConfig = { beacon: false };

/**
 * "ran JS" on load and "engaged-15s" after 15s with the tab visible, tagged with the page path.
 * Fetchers posing as browsers send neither, so these split real readers from scanners.
 */
function beaconScript(path: string): string {
  const p = encodeURIComponent(path);
  return `<script>(function(){function evt(n){try{navigator.sendBeacon('/api/evt?e='+n+'&p=${p}')}catch(e){}}
evt('js');var shown=0,t0=Date.now(),sent=0;
(function tick(){if(sent)return;if(document.visibilityState==='visible')shown+=Date.now()-t0;t0=Date.now();if(shown>=15000){sent=1;evt('engaged-15s')}else setTimeout(tick,1000)})();})();</script>`;
}

export interface PageOptions {
  title: string;
  body: string;
  /** Page-specific CSS, after the brand tokens. */
  css?: string;
  description?: string;
  noindex?: boolean;
  /** Extra head tags (canonical, alternate, JSON-LD, ...). */
  head?: string;
  /** Path for the beacon (only sent when layoutConfig.beacon is on). */
  beaconPath?: string;
}

export function page(o: PageOptions): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
${o.noindex ? '<meta name="robots" content="noindex"/>\n' : ""}<title>${escapeHtml(o.title)}</title>
${o.description ? `<meta name="description" content="${escapeHtml(o.description)}"/>\n` : ""}<link rel="icon" href="/favicon.svg" type="image/svg+xml"/>
${FONT_LINKS}
${o.head ?? ""}<style>${TOKENS_CSS}${o.css ?? ""}</style></head>
<body>${o.body}${layoutConfig.beacon && o.beaconPath ? beaconScript(o.beaconPath) : ""}</body></html>`;
}
