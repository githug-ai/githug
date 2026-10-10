// Lets Node import `.md` files as strings, like wrangler's Text rule (wrangler.jsonc → rules).
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
import { readFile } from "node:fs/promises";
export async function load(url, context, next) {
  if (url.endsWith(".md")) {
    const text = await readFile(new URL(url), "utf8");
    return { format: "module", source: "export default " + JSON.stringify(text), shortCircuit: true };
  }
  return next(url, context);
}`));
