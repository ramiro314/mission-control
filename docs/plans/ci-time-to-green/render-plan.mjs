// Usage:
//   node render-plan.mjs          write plan.html from plan.md
//   node render-plan.mjs --check  fail if plan.html is not current
//
// plan.md is the source of truth. Its one mermaid block is the text definition of the CI
// job graph; job-graph.svg is that graph's drawing, inlined here in the block's place so the page
// stays self-contained and opens offline. Edit both together when the graph changes.
//
// `marked` is not a direct dependency of this repository; it resolves from node_modules only
// because another package installs it. A lockfile update can remove it, which breaks this
// script, or move it to a version that renders differently. `--check` therefore holds only for
// the `marked` version that last wrote plan.html. If it reports a stale page while plan.md is
// unchanged, re-render and commit the result; that diff is the renderer's, not the plan's.
import { readFileSync, writeFileSync } from "node:fs";
import { marked } from "marked";

const checkOnly = process.argv.includes("--check");
const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const outputPath = new URL("./plan.html", import.meta.url);

const source = read("plan.md");
const diagram = `<div class="wide">${read("job-graph.svg").trim()}</div>`;

let body = marked.parse(source, { gfm: true });
const mermaid = /<pre><code class="language-mermaid">[\s\S]*?<\/code><\/pre>/;
if (!mermaid.test(body)) throw new Error("plan.md has no mermaid block for job-graph.svg to replace");
body = body
  .replace(mermaid, diagram)
  .replace(/<table>/g, '<div class="wide"><table>')
  .replace(/<\/table>/g, "</table></div>");

const title = source.match(/^# (.*)$/m)[1];
const css = `:root{color-scheme:dark;--bg:#10151d;--panel:#1a2432;--ink:#edf3fa;--muted:#b8c9dc;--line:#52647c;--link:#9bcfff;--new:#1f3a2a}
@media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#f4f7fb;--panel:#fff;--ink:#132239;--muted:#344d68;--line:#8899ad;--link:#064b8b;--new:#e3f4e8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.65 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}main{max-width:1080px;margin:auto;padding:44px 24px 80px}h1{font-size:clamp(28px,3.6vw,42px);line-height:1.15;letter-spacing:-.02em;margin:0 0 25px}h2{font-size:25px;margin:42px 0 15px}h3{font-size:20px;margin:28px 0 12px}p,li{max-width:94ch;overflow-wrap:anywhere}a{color:var(--link)}code{font:.88em/1.6 ui-monospace,monospace;overflow-wrap:anywhere}pre{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px}.wide{overflow-x:auto;max-width:100%;border:1px solid var(--line);border-radius:10px;margin:20px 0;background:var(--panel)}table{border-collapse:collapse;min-width:660px;width:100%;font-size:15px}th,td{padding:11px 14px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}tr:last-child td{border-bottom:0}svg{display:block;min-width:900px;width:100%;height:auto}svg rect{fill:var(--panel);stroke:var(--line)}svg rect.new{fill:var(--new);stroke:var(--link);stroke-width:2}svg text{fill:var(--ink);font:16px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}svg .small{font-size:13px;fill:var(--muted)}svg path{stroke:var(--link);fill:none;stroke-width:2}svg polygon{fill:var(--link)}li{margin:7px 0}`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>\n${css}\n</style></head><body><main>\n${body}</main></body></html>\n`;

if (checkOnly) {
  if (readFileSync(outputPath, "utf8") !== html) {
    console.error("plan.html is stale: run node docs/plans/ci-time-to-green/render-plan.mjs");
    process.exit(1);
  }
} else {
  writeFileSync(outputPath, html);
}
