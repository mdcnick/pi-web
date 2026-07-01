export function formatTelegramResponse(config, text) {
  if (config.telegramFormatting?.enabled === false) return text;
  return simplifyTelegramMarkdown(rewriteMarkdownTables(text)).trim();
}

export function rewriteMarkdownTables(text) {
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isMarkdownTableStart(lines, index)) {
      output.push(lines[index]);
      continue;
    }
    const tableLines = collectTableLines(lines, index);
    index += tableLines.length - 1;
    output.push(...markdownTableToBullets(tableLines));
  }
  return output.join("\n");
}

function collectTableLines(lines, startIndex) {
  const tableLines = [lines[startIndex], lines[startIndex + 1]];
  for (let index = startIndex + 2; index < lines.length && looksLikeTableRow(lines[index]); index += 1) {
    tableLines.push(lines[index]);
  }
  return tableLines;
}

function markdownTableToBullets(lines) {
  const headers = splitTableRow(lines[0]);
  const rows = lines.slice(2).map(splitTableRow).filter((row) => row.some((cell) => cell !== ""));
  if (headers.length === 0 || rows.length === 0) return lines;
  return rows.flatMap((row) => tableRowToBullets(headers, row));
}

function tableRowToBullets(headers, row) {
  const title = row[0] || "Item";
  const details = headers
    .slice(1)
    .map((header, index) => tableCellDetail(header, row[index + 1] ?? ""))
    .filter(Boolean);
  if (details.length === 0) return [`• ${title}`];
  return [`• ${title}`, ...details.map((detail) => `  ${detail}`)];
}

function tableCellDetail(header, value) {
  return value === "" ? undefined : `${header}: ${value}`;
}

function isMarkdownTableStart(lines, index) {
  return looksLikeTableRow(lines[index]) && index + 1 < lines.length && isTableSeparator(lines[index + 1]);
}

function looksLikeTableRow(line) {
  return line.includes("|") && splitTableRow(line).length >= 2;
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line);
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
}

export function simplifyTelegramMarkdown(text) {
  const lines = text.split("\n");
  let inFence = false;
  return lines.map((line) => {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      return line.replace(/^```[a-zA-Z0-9_-]*\s*$/u, "```");
    }
    if (inFence) return line;
    return simplifyTelegramMarkdownLine(line);
  }).join("\n");
}

function simplifyTelegramMarkdownLine(line) {
  return line
    .replace(/^#{1,6}\s+/u, "")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/__([^_]+)__/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/^\s*[-*]\s+/u, "• ");
}
