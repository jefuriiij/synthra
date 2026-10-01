// The large panel's HTML shell. Pure (no `vscode`), so it is tested with the
// rest of the extension logic. Same CSP as Hermes Studio's:
//
//   - script-src is nonce-only. Svelte 5 compiles event handlers to listeners,
//     so no inline script is ever needed.
//   - style-src carries 'unsafe-inline' and NO nonce: a nonce in style-src makes
//     the browser ignore 'unsafe-inline', which breaks Svelte's style
//     attributes. Notes and skill texts are rendered as text, never as HTML.
//   - No connect-src: the page never talks to the network; the host does.

export interface HtmlInput {
  /** webview.cspSource */
  cspSource: string;
  /** Random, base64: crypto.randomBytes(16).toString("base64") */
  nonce: string;
  /** webview.asWebviewUri(...) for dist/webview/webview.js */
  scriptUri: string;
  /** webview.asWebviewUri(...) for dist/webview/webview.css */
  styleUri: string;
}

export function buildCsp(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    `img-src ${cspSource} data:`,
  ].join("; ");
}

export function buildHtml(i: HtmlInput): string {
  const attr = escapeAttr;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${attr(buildCsp(i.cspSource, i.nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attr(i.styleUri)}">
<title>Synthra</title>
</head>
<body>
<div id="app"></div>
<script type="module" nonce="${attr(i.nonce)}" src="${attr(i.scriptUri)}"></script>
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
