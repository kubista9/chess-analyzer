// Copies dist/index.html to dist/404.html after a build, so static hosts without rewrite rules
// (GitHub Pages and similar) still open deep links such as /practice/sparring.
import fs from "node:fs";

fs.copyFileSync("dist/index.html", "dist/404.html");
console.log("dist/404.html written (SPA fallback)");
