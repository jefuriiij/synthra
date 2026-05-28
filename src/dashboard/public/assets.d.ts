// Tsup's text loader (see tsup.config.ts) lets us import the dashboard's
// static assets as plain strings so dashboard/server.ts can serve them.

declare module "*.html" {
  const content: string;
  export default content;
}

declare module "*.css" {
  const content: string;
  export default content;
}
