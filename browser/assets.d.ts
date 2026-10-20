// The browser build embeds images and extracts CSS into the application stylesheet.
declare module "*.css" {}
declare module "*.png" {
  const source: string;
  export default source;
}
