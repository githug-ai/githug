// Markdown files imported as strings. In the Worker build this is wired by the
// wrangler `Text` module rule (see wrangler.jsonc); the declaration just teaches
// TypeScript that `import body from "./post.md"` yields the file's contents.
declare module "*.md" {
  const content: string;
  export default content;
}
