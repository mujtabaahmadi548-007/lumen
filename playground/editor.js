/**
 * Lumen Playground Code Editor (`playground/editor.js`)
 * Provides:
 *   - Synchronized line numbers & clickable breakpoint gutter
 *   - Live Lumen syntax highlighting overlay
 *   - Exact `startLine:startCol..endCol` wavy red error squiggles
 *   - Mouse hover diagnostic tooltip (with error code, caret snippet, and fix suggestion)
 *   - Active debug line highlight bar & inline diagnostic drawer
 */

const KEYWORDS = new Set([
  "fn",
  "let",
  "mut",
  "if",
  "else",
  "while",
  "for",
  "in",
  "match",
  "return",
  "break",
  "continue",
  "struct",
  "enum",
  "import",
  "pub",
  "const",
  "as",
  "type",
]);

const TYPES = new Set([
  "i32",
  "i64",
  "f64",
  "bool",
  "string",
  "void",
  "Option",
  "Result",
  "Vec",
  "HashMap",
]);

const VARIANTS = new Set(["Some", "None", "Ok", "Err"]);

const BOOL_LITS = new Set(["true", "false"]);

const BUILTINS = new Set([
  "print",
  "println",
  "int_to_string",
  "i64_to_string",
  "float_to_string",
  "bool_to_string",
  "int_to_float",
  "float_to_int",
  "i32_to_i64",
  "i64_to_i32",
  "str_len",
  "str_concat",
  "str_slice",
  "str_char_at",
  "str_from_char_code",
  "str_eq",
  "str_hash",
  "str_to_int",
  "array_len",
  "array_push",
  "array_pop",
  "array_new",
  "sqrt",
  "sin",
  "cos",
  "abs_f64",
  "abs_i32",
  "floor",
  "ceil",
  "pow",
  "gc_collect",
  "gc_live_bytes",
  "gc_total_allocated",
  "gc_collection_count",
  "clock_ms",
  "assert",
  "panic",
]);

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Tokenize a single line of Lumen code into syntax-colored spans,
 * and overlay wavy error squiggles for any diagnostics on that line.
 */
function renderHighlightedLine(lineText, lineNumber, lineDiagnostics) {
  const len = lineText.length;
  // Build per-character diagnostic marker array if this line has diagnostics
  const charDiag = new Array(Math.max(len + 1, 1)).fill(null);

  if (lineDiagnostics && lineDiagnostics.length > 0) {
    for (const d of lineDiagnostics) {
      const span = d.span || {};
      let sCol = Math.max(1, Number(span.startCol || 1)) - 1;
      let eCol =
        span.endLine && span.endLine > lineNumber
          ? len
          : Math.max(sCol + 1, Number(span.endCol || sCol + 2) - 1);
      if (sCol >= len) {
        sCol = Math.max(0, len - 1);
        eCol = len;
      }
      eCol = Math.min(Math.max(sCol + 1, eCol), Math.max(len, 1));
      for (let c = sCol; c < eCol; c++) {
        if (!charDiag[c] || d.severity === "error") {
          charDiag[c] = d;
        }
      }
    }
  }

  // Tokenize the line into segments: { start, end, cls }
  const segments = [];
  let i = 0;
  while (i < len) {
    const ch = lineText[i];
    const next = lineText[i + 1] || "";

    // 1. Line comment `// ...`
    if (ch === "/" && next === "/") {
      segments.push({ start: i, end: len, cls: "tok-comment" });
      break;
    }

    // 2. String literal `"..."`
    if (ch === '"') {
      let j = i + 1;
      while (j < len) {
        if (lineText[j] === "\\") {
          j += 2;
          continue;
        }
        if (lineText[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      segments.push({ start: i, end: j, cls: "tok-string" });
      i = j;
      continue;
    }

    // 3. Numeric literal
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      if (ch === "0" && (next === "x" || next === "X")) {
        j += 1;
        while (j < len && /[0-9a-fA-F_]/.test(lineText[j])) j++;
      } else {
        while (j < len && /[0-9._]/.test(lineText[j])) j++;
        if (j < len && lineText.slice(j).startsWith("i64")) j += 3;
        else if (j < len && lineText.slice(j).startsWith("i32")) j += 3;
        else if (j < len && lineText.slice(j).startsWith("f64")) j += 3;
      }
      segments.push({ start: i, end: j, cls: "tok-number" });
      i = j;
      continue;
    }

    // 4. Identifier or Keyword
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[a-zA-Z0-9_]/.test(lineText[j])) j++;
      const word = lineText.slice(i, j);
      let cls = "";
      if (KEYWORDS.has(word)) {
        cls = "tok-keyword";
      } else if (BOOL_LITS.has(word)) {
        cls = "tok-bool";
      } else if (TYPES.has(word)) {
        cls = "tok-type";
      } else if (VARIANTS.has(word)) {
        cls = "tok-enum-variant";
      } else if (BUILTINS.has(word)) {
        cls = "tok-builtin";
      } else if (/^[A-Z]/.test(word)) {
        cls = "tok-type";
      } else {
        // Check if followed by `(` or `::<`
        let k = j;
        while (k < len && lineText[k] === " ") k++;
        if (lineText[k] === "(") {
          cls = "tok-fn";
        }
      }
      segments.push({ start: i, end: j, cls });
      i = j;
      continue;
    }

    // 5. Operators & Punctuation
    if ("+-*/%=!<>&|^~:;,.?()[]{}".includes(ch)) {
      let j = i + 1;
      while (j < len && "+-*/%=!<>&|^~:".includes(lineText[j])) j++;
      segments.push({ start: i, end: j, cls: "tok-op" });
      i = j;
      continue;
    }

    // 6. Whitespace / other
    let j = i + 1;
    while (j < len && lineText[j] === " ") j++;
    segments.push({ start: i, end: j, cls: "" });
    i = j;
  }

  if (segments.length === 0) {
    // Empty line: still show squiggle if there is a diagnostic on this line
    if (lineDiagnostics && lineDiagnostics.length > 0) {
      return `<span class="squiggle-error"> </span>`;
    }
    return "";
  }

  // Render segments while splitting on diagnostic squiggle boundaries
  let html = "";
  for (const seg of segments) {
    let runStart = seg.start;
    let curDiag = charDiag[runStart];
    for (let pos = seg.start + 1; pos <= seg.end; pos++) {
      const nextDiag = pos < seg.end ? charDiag[pos] : undefined;
      if (pos === seg.end || nextDiag !== curDiag) {
        const chunk = escapeHtml(lineText.slice(runStart, pos));
        const tokSpan = seg.cls ? `<span class="${seg.cls}">${chunk}</span>` : chunk;
        if (curDiag) {
          const sqClass = curDiag.severity === "warning" ? "squiggle-warning" : "squiggle-error";
          html += `<span class="${sqClass}">${tokSpan}</span>`;
        } else {
          html += tokSpan;
        }
        runStart = pos;
        curDiag = nextDiag;
      }
    }
  }

  return html;
}

export class LumenEditor {
  constructor(options = {}) {
    this.textarea = document.getElementById("editor-textarea");
    this.gutter = document.getElementById("editor-gutter");
    this.highlightLayer = document.getElementById("editor-highlight-layer");
    this.highlightCode = document.getElementById("editor-highlight-code");
    this.lineHighlights = document.getElementById("editor-line-highlights");
    this.viewport = document.getElementById("editor-viewport");
    this.tooltip = document.getElementById("editor-tooltip");
    this.cursorIndicator = document.getElementById("cursor-pos-indicator");
    this.bpCountBadge = document.getElementById("breakpoint-count-badge");
    this.diagCountBadge = document.getElementById("diag-count-badge");
    this.diagBar = document.getElementById("editor-diagnostics-bar");
    this.diagBarList = document.getElementById("diag-bar-list");
    this.diagBarTitle = document.getElementById("diag-bar-title");
    this.diagBarClose = document.getElementById("diag-bar-close");

    this.onChange = options.onChange || (() => {});
    this.onRunWasm = options.onRunWasm || (() => {});
    this.onDebug = options.onDebug || (() => {});
    this.onFormat = options.onFormat || (() => {});
    this.onStepAction = options.onStepAction || (() => {});
    this.onBreakpointsChange = options.onBreakpointsChange || (() => {});

    this.breakpoints = new Set(); // 1-indexed line numbers
    this.diagnostics = [];
    this.diagnosticsByLine = new Map();
    this.debugActiveLine = null; // 1-indexed line number when paused in debugger
    this.activeCursorLine = 1;

    this._charWidth = 8.1; // Measured dynamically on init
    this._lineHeight = 21;
    this._padX = 14;
    this._padY = 12;

    this._bindEvents();
    this._measureFontMetrics();
  }

  _measureFontMetrics() {
    const probe = document.createElement("span");
    probe.style.fontFamily = 'var(--font-mono)';
    probe.style.fontSize = "13.5px";
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.whiteSpace = "pre";
    probe.textContent = "MMMMMMMMMM";
    document.body.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    if (rect.width > 0) {
      this._charWidth = rect.width / 10;
    }
    document.body.removeChild(probe);
  }

  _bindEvents() {
    if (!this.textarea) return;

    this.textarea.addEventListener("input", () => {
      this._updateCursorPosition();
      this.render();
      this.onChange(this.getValue());
    });

    this.textarea.addEventListener("scroll", () => {
      this._syncScroll();
      this._hideTooltip();
    });

    this.textarea.addEventListener("click", () => {
      this._updateCursorPosition();
      this._renderLineBackdrops();
    });

    this.textarea.addEventListener("keyup", () => {
      this._updateCursorPosition();
      this._renderLineBackdrops();
    });

    this.textarea.addEventListener("keydown", (e) => {
      // Ctrl+Enter / Cmd+Enter -> Run Wasm
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        this.onRunWasm();
        return;
      }
      // Shift+Alt+F -> Format
      if (e.shiftKey && e.altKey && (e.key === "F" || e.key === "f")) {
        e.preventDefault();
        this.onFormat();
        return;
      }
      // F5 -> Start Debug
      if (e.key === "F5") {
        e.preventDefault();
        this.onDebug();
        return;
      }
      // F8 -> Continue
      if (e.key === "F8") {
        e.preventDefault();
        this.onStepAction("continue");
        return;
      }
      // F10 -> Step Over
      if (e.key === "F10") {
        e.preventDefault();
        this.onStepAction("stepOver");
        return;
      }
      // F11 / Shift+F11 -> Step Into / Step Out
      if (e.key === "F11") {
        e.preventDefault();
        this.onStepAction(e.shiftKey ? "stepOut" : "stepInto");
        return;
      }

      // Tab key -> insert 4 spaces
      if (e.key === "Tab") {
        e.preventDefault();
        const start = this.textarea.selectionStart;
        const end = this.textarea.selectionEnd;
        const val = this.textarea.value;
        this.textarea.value = val.slice(0, start) + "    " + val.slice(end);
        this.textarea.selectionStart = this.textarea.selectionEnd = start + 4;
        this._updateCursorPosition();
        this.render();
        this.onChange(this.getValue());
        return;
      }

      // Enter key -> smart auto-indent
      if (e.key === "Enter") {
        const start = this.textarea.selectionStart;
        const end = this.textarea.selectionEnd;
        const val = this.textarea.value;
        const lineStart = val.lastIndexOf("\n", start - 1) + 1;
        const currentLine = val.slice(lineStart, start);
        const indentMatch = currentLine.match(/^[ \t]*/);
        let indent = indentMatch ? indentMatch[0] : "";
        const trimmed = currentLine.trimEnd();
        if (trimmed.endsWith("{") || trimmed.endsWith("(")) {
          indent += "    ";
        }
        e.preventDefault();
        const insertStr = "\n" + indent;
        this.textarea.value = val.slice(0, start) + insertStr + val.slice(end);
        this.textarea.selectionStart = this.textarea.selectionEnd = start + insertStr.length;
        this._updateCursorPosition();
        this.render();
        this.onChange(this.getValue());
      }
    });

    // Hover over squiggles in viewport to show diagnostic tooltip
    this.textarea.addEventListener("mousemove", (e) => {
      this._handleMouseMove(e);
    });

    this.textarea.addEventListener("mouseleave", () => {
      this._hideTooltip();
    });

    // Gutter click -> toggle breakpoint on clicked line
    if (this.gutter) {
      this.gutter.addEventListener("click", (e) => {
        const row = e.target.closest(".gutter-line");
        if (!row) return;
        const lineNum = Number(row.dataset.line);
        if (lineNum >= 1) {
          this.toggleBreakpoint(lineNum);
        }
      });
    }

    if (this.bpCountBadge) {
      this.bpCountBadge.addEventListener("click", () => {
        if (this.breakpoints.size > 0) {
          this.breakpoints.clear();
          this.renderGutter();
          this._updateBreakpointBadge();
          this.onBreakpointsChange(this.getBreakpoints());
        }
      });
    }

    if (this.diagBarClose) {
      this.diagBarClose.addEventListener("click", () => {
        this.diagBar.classList.add("hidden");
      });
    }
  }

  _syncScroll() {
    const top = this.textarea.scrollTop;
    const left = this.textarea.scrollLeft;
    if (this.highlightLayer) {
      this.highlightLayer.scrollTop = top;
      this.highlightLayer.scrollLeft = left;
    }
    if (this.lineHighlights) {
      this.lineHighlights.scrollTop = top;
    }
    if (this.gutter) {
      this.gutter.scrollTop = top;
    }
  }

  _updateCursorPosition() {
    if (!this.textarea) return;
    const pos = this.textarea.selectionStart || 0;
    const textUpToCursor = this.textarea.value.slice(0, pos);
    const lines = textUpToCursor.split("\n");
    const ln = lines.length;
    const col = lines[lines.length - 1].length + 1;
    this.activeCursorLine = ln;
    if (this.cursorIndicator) {
      this.cursorIndicator.textContent = `Ln ${ln}, Col ${col}`;
    }
  }

  _handleMouseMove(e) {
    if (this.diagnostics.length === 0) {
      this._hideTooltip();
      return;
    }
    const rect = this.textarea.getBoundingClientRect();
    const relY = e.clientY - rect.top + this.textarea.scrollTop - this._padY;
    const relX = e.clientX - rect.left + this.textarea.scrollLeft - this._padX;

    const lineNum = Math.floor(relY / this._lineHeight) + 1;
    const colNum = Math.floor(relX / this._charWidth) + 1;

    const lineDiags = this.diagnosticsByLine.get(lineNum);
    if (!lineDiags || lineDiags.length === 0) {
      this._hideTooltip();
      return;
    }

    // Match diagnostic spanning colNum or fallback to first diagnostic on that line
    let matched = lineDiags.find((d) => {
      const s = d.span?.startCol || 1;
      const end = Math.max(s + 1, d.span?.endCol || s + 4);
      return colNum >= s - 1 && colNum <= end + 2;
    });
    if (!matched) {
      matched = lineDiags[0];
    }

    this._showTooltip(matched, e.clientX - rect.left, e.clientY - rect.top);
  }

  _showTooltip(diag, x, y) {
    if (!this.tooltip || !diag) return;
    const code = escapeHtml(diag.code || "E0000");
    const msg = escapeHtml(diag.message || "Compiler error");
    const lineNum = diag.span?.startLine || 1;
    const colNum = diag.span?.startCol || 1;
    const suggestionHtml = diag.suggestion
      ? `<div class="tooltip-help">💡 help: ${escapeHtml(diag.suggestion)}</div>`
      : "";

    this.tooltip.innerHTML = `
      <div class="tooltip-header">
        <span class="tooltip-code">${code}</span>
        <span>Ln ${lineNum}, Col ${colNum}</span>
      </div>
      <div>${msg}</div>
      ${suggestionHtml}
    `;
    this.tooltip.classList.remove("hidden");

    const maxLeft = Math.max(10, this.viewport.clientWidth - 360);
    const left = Math.min(Math.max(12, x + 10), maxLeft);
    const top = Math.max(12, y + 20);
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${top}px`;
  }

  _hideTooltip() {
    if (this.tooltip) {
      this.tooltip.classList.add("hidden");
    }
  }

  getValue() {
    return this.textarea ? this.textarea.value : "";
  }

  setValue(source, preserveBreakpoints = false) {
    if (!this.textarea) return;
    this.textarea.value = source;
    if (!preserveBreakpoints) {
      this.breakpoints.clear();
      this._updateBreakpointBadge();
      this.onBreakpointsChange(this.getBreakpoints());
    }
    this.debugActiveLine = null;
    this._updateCursorPosition();
    this.render();
  }

  setDiagnostics(diagnostics = []) {
    this.diagnostics = Array.isArray(diagnostics) ? diagnostics : [];
    this.diagnosticsByLine.clear();
    for (const d of this.diagnostics) {
      const ln = d.span?.startLine || 1;
      if (!this.diagnosticsByLine.has(ln)) {
        this.diagnosticsByLine.set(ln, []);
      }
      this.diagnosticsByLine.get(ln).push(d);
    }

    // Update badge
    if (this.diagCountBadge) {
      const errCount = this.diagnostics.filter((d) => d.severity !== "warning").length;
      if (errCount === 0) {
        this.diagCountBadge.textContent = "0 Errors";
        this.diagCountBadge.className = "meta-pill diag-ok";
      } else {
        this.diagCountBadge.textContent = `${errCount} Error${errCount === 1 ? "" : "s"}`;
        this.diagCountBadge.className = "meta-pill diag-err";
      }
    }

    this._renderDiagnosticsDrawer();
    this.render();
  }

  _renderDiagnosticsDrawer() {
    if (!this.diagBar || !this.diagBarList) return;
    if (this.diagnostics.length === 0) {
      this.diagBar.classList.add("hidden");
      this.diagBarList.innerHTML = "";
      return;
    }

    this.diagBar.classList.remove("hidden");
    if (this.diagBarTitle) {
      this.diagBarTitle.textContent = `Compiler Diagnostics (${this.diagnostics.length})`;
    }

    this.diagBarList.innerHTML = this.diagnostics
      .map((d, idx) => {
        const ln = d.span?.startLine || 1;
        const col = d.span?.startCol || 1;
        const code = escapeHtml(d.code || "E0000");
        const msg = escapeHtml(d.message || "");
        const help = d.suggestion
          ? `<div class="diag-suggestion">help: ${escapeHtml(d.suggestion)}</div>`
          : "";
        return `
          <div class="diag-item" data-diag-idx="${idx}" data-line="${ln}" data-col="${col}">
            <div class="diag-item-top">
              <span class="tooltip-code">${code}</span>
              <span class="diag-loc-pill">Ln ${ln}, Col ${col}</span>
              <span class="diag-msg">${msg}</span>
            </div>
            ${help}
          </div>
        `;
      })
      .join("");

    this.diagBarList.querySelectorAll(".diag-item").forEach((el) => {
      el.addEventListener("click", () => {
        const ln = Number(el.dataset.line || 1);
        const col = Number(el.dataset.col || 1);
        this.jumpToLine(ln, col);
      });
    });
  }

  jumpToLine(lineNumber, colNumber = 1) {
    if (!this.textarea) return;
    const lines = this.textarea.value.split("\n");
    const clampedLine = Math.max(1, Math.min(lineNumber, lines.length));
    let offset = 0;
    for (let i = 0; i < clampedLine - 1; i++) {
      offset += lines[i].length + 1;
    }
    offset += Math.max(0, Math.min(colNumber - 1, lines[clampedLine - 1].length));

    this.textarea.focus();
    this.textarea.setSelectionRange(offset, offset);
    this.activeCursorLine = clampedLine;
    this.scrollToLine(clampedLine);
    this._updateCursorPosition();
    this._renderLineBackdrops();
  }

  scrollToLine(lineNumber) {
    if (!this.textarea) return;
    const targetY = (lineNumber - 1) * this._lineHeight;
    const viewH = this.textarea.clientHeight;
    if (targetY < this.textarea.scrollTop + 20 || targetY > this.textarea.scrollTop + viewH - 42) {
      this.textarea.scrollTop = Math.max(0, targetY - viewH / 3);
      this._syncScroll();
    }
  }

  toggleBreakpoint(lineNumber) {
    if (this.breakpoints.has(lineNumber)) {
      this.breakpoints.delete(lineNumber);
    } else {
      this.breakpoints.add(lineNumber);
    }
    this._updateBreakpointBadge();
    this.renderGutter();
    this.onBreakpointsChange(this.getBreakpoints());
  }

  getBreakpoints() {
    return Array.from(this.breakpoints).sort((a, b) => a - b);
  }

  setBreakpoints(lines = []) {
    this.breakpoints = new Set(lines);
    this._updateBreakpointBadge();
    this.renderGutter();
    this.onBreakpointsChange(this.getBreakpoints());
  }

  _updateBreakpointBadge() {
    if (!this.bpCountBadge) return;
    const count = this.breakpoints.size;
    this.bpCountBadge.textContent = `${count} Breakpoint${count === 1 ? "" : "s"}`;
  }

  setDebugActiveLine(lineNumber = null) {
    this.debugActiveLine = lineNumber;
    this.renderGutter();
    this._renderLineBackdrops();
    if (lineNumber && lineNumber >= 1) {
      this.scrollToLine(lineNumber);
    }
  }

  renderGutter() {
    if (!this.gutter || !this.textarea) return;
    const lineCount = this.textarea.value.split("\n").length;
    let html = "";
    for (let ln = 1; ln <= lineCount; ln++) {
      const hasBp = this.breakpoints.has(ln);
      const isDebug = this.debugActiveLine === ln;
      const hasErr = this.diagnosticsByLine.has(ln);
      const classes = [
        "gutter-line",
        hasBp ? "has-breakpoint" : "",
        isDebug ? "is-debug-line" : "",
        hasErr ? "has-error" : "",
      ]
        .filter(Boolean)
        .join(" ");

      const marker = isDebug
        ? `<span class="debug-arrow">▶</span>`
        : `<span class="bp-dot"></span>`;

      html += `<div class="${classes}" data-line="${ln}" title="Click to toggle breakpoint on line ${ln}">
        <span class="gutter-markers">${marker}</span>
        <span class="gutter-lnum">${ln}</span>
      </div>`;
    }
    this.gutter.innerHTML = html;
  }

  _renderLineBackdrops() {
    if (!this.lineHighlights || !this.textarea) return;
    const lineCount = this.textarea.value.split("\n").length;
    let html = "";
    for (let ln = 1; ln <= lineCount; ln++) {
      let cls = "line-bg-row";
      if (this.debugActiveLine === ln) {
        cls += " line-bg-debug";
      } else if (this.diagnosticsByLine.has(ln)) {
        cls += " line-bg-error";
      } else if (this.activeCursorLine === ln) {
        cls += " line-bg-active";
      }
      html += `<div class="${cls}"></div>`;
    }
    this.lineHighlights.innerHTML = html;
  }

  render() {
    if (!this.textarea || !this.highlightCode) return;
    const lines = this.textarea.value.split("\n");
    const highlightedLines = lines.map((lineText, idx) => {
      const ln = idx + 1;
      const lineDiags = this.diagnosticsByLine.get(ln) || null;
      return renderHighlightedLine(lineText, ln, lineDiags);
    });
    // Trailing newline ensures scroll height parity with textarea
    this.highlightCode.innerHTML = highlightedLines.join("\n") + "\n";
    this.renderGutter();
    this._renderLineBackdrops();
    this._syncScroll();
  }
}
