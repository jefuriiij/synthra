// Tsup's text loader (see tsup.config.ts) lets us import these scripts
// as plain strings so installer.ts can write them at install time.

declare module "*.ps1" {
  const content: string;
  export default content;
}

declare module "*.sh" {
  const content: string;
  export default content;
}
