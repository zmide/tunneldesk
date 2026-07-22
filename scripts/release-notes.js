const fs = require("node:fs");

const tag = process.env.GITHUB_REF_NAME || process.argv[2] || "";
const version = tag.startsWith("v") ? tag : `v${tag}`;
const pattern = new RegExp(`## ${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n([\\s\\S]*?)(?=\\n## |$)`);
const localNotesPath = "docs/update.md";
const publishedNotesPath = `.github/release-notes/${version}.md`;

let body = "";
if (fs.existsSync(localNotesPath)) {
  const match = fs.readFileSync(localNotesPath, "utf8").match(pattern);
  if (match) body = `## ${version}\n${match[1].trim()}\n`;
}
if (!body && fs.existsSync(publishedNotesPath)) {
  body = fs.readFileSync(publishedNotesPath, "utf8").trimEnd() + "\n";
}
if (!body) body = `## ${version}\n\n暂无发布说明。\n`;

fs.writeFileSync("release-notes.md", body, "utf8");
