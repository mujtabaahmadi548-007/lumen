/**
 * Lumen Diagnostic Renderer (`src/frontend/diagnostics.js`)
 * Formats compiler diagnostics with source snippets, line/col gutters, carets, and fix suggestions.
 */

function resolveSourceLine(diag, sourceTextOrMap) {
  const span = diag?.span;
  const lineNum = span?.startLine || 1;
  const file = span?.file || "<input>";

  let fullSource = null;
  if (typeof sourceTextOrMap === "string") {
    fullSource = sourceTextOrMap;
  } else if (sourceTextOrMap instanceof Map) {
    fullSource =
      sourceTextOrMap.get(file) ??
      (sourceTextOrMap.size > 0
        ? sourceTextOrMap.values().next().value
        : null);
  } else if (sourceTextOrMap && typeof sourceTextOrMap === "object") {
    fullSource = sourceTextOrMap[file] ?? null;
  }

  if (typeof fullSource === "string" && fullSource.length > 0) {
    const lines = fullSource.split(/\r?\n/);
    if (lineNum >= 1 && lineNum <= lines.length) {
      return lines[lineNum - 1];
    }
  }

  return diag?.sourceLine || "";
}

/**
 * Render a single Diagnostic into a human-readable compiler message.
 * @param {object} diag
 * @param {string | Map<string, string> | Record<string, string>} [sourceTextOrMap]
 * @returns {string}
 */
export function renderDiagnostic(diag, sourceTextOrMap = null) {
  if (!diag) return "";

  const severity = diag.severity || "error";
  const code = diag.code || "E0000";
  const message = diag.message || "unknown compiler error";
  const span = diag.span || {
    file: "<input>",
    startLine: 1,
    startCol: 1,
    endLine: 1,
    endCol: 2,
  };

  const file = span.file || "<input>";
  const startLine = Math.max(1, span.startLine || 1);
  const startCol = Math.max(1, span.startCol || 1);
  const endLine = span.endLine || startLine;
  const endCol = span.endCol || startCol + 1;

  const sourceLine = resolveSourceLine(diag, sourceTextOrMap);
  const lineStr = String(startLine);
  const gutterPad = " ".repeat(lineStr.length);

  // Compute caret offset and underline width on `startLine`
  const caretPadCount = Math.max(0, startCol - 1);
  let caretLen = 1;
  if (endLine === startLine && endCol > startCol) {
    caretLen = endCol - startCol;
  } else if (endLine > startLine && sourceLine.length >= startCol) {
    caretLen = Math.max(1, sourceLine.length - caretPadCount);
  }
  const carets = " ".repeat(caretPadCount) + "^".repeat(Math.max(1, caretLen));

  const out = [];
  out.push(`${severity}[${code}]: ${message}`);
  out.push(`${gutterPad}--> ${file}:${startLine}:${startCol}`);
  out.push(`${gutterPad} |`);
  out.push(`${lineStr} | ${sourceLine}`);
  out.push(`${gutterPad} | ${carets}`);

  if (diag.suggestion) {
    out.push(`${gutterPad} = help: ${diag.suggestion}`);
  }

  return out.join("\n");
}

/**
 * Render an array of Diagnostics into a single formatted string.
 * @param {Array<object>} diags
 * @param {string | Map<string, string> | Record<string, string>} [sourceTextOrMap]
 * @returns {string}
 */
export function renderDiagnostics(diags, sourceTextOrMap = null) {
  if (!Array.isArray(diags) || diags.length === 0) {
    return "";
  }
  return diags
    .map((d) => renderDiagnostic(d, sourceTextOrMap))
    .join("\n\n");
}
