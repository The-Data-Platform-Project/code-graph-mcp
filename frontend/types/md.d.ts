// Markdown files are imported as strings (webpack asset/source, next.config.mjs).
declare module "*.md" {
  const content: string;
  export default content;
}
