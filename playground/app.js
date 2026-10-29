/**
 * Lumen Browser Playground Application (`playground/app.js`) — M1 Scope
 *
 * Imports `/src/compiler.js` directly in the browser via `<script type="module">`
 * to compile `.lm` source to `.wasm` bytes and execute it live via `WebAssembly.instantiate`
 * (with automatic fallback to `POST /api/compile`), while checking parity against
 * the Reference Interpreter (`runSourceInterp`).
 */

import { LumenEditor } from "./editor.js";
import { formatFloat64, LumenRuntimeError } from "/src/contracts/index.js";

const HELLO_WORLD_SOURCE = `fn main() {\n    println("Hello, World!");\n}\n`;

const DIAGNOSTICS_DEMO_SOURCE = `fn main() {\n    let msg: i32 = "type mismatch demo";\n    println(undeclared_var);\n}\n`;

const WASM_SECTION_NAMES = Object.freeze({
  0: "Custom (0)",
  1: "Type (1)",
  2: "Import (2)",
  3: "Function (3)",
  4: "Table (4)",
  5: "Memory (5)",
  6: "Global (6)",
  7: "Export (7)",
  8: "Start (8)",
  9: "Element (9)",
  10: "Code (10)",
  11: "Data (11)",
});

/**
 * Format a `.wasm` Uint8Array into a structured section summary + 16-byte-per-row hex/ASCII dump.
 */
function formatWasmHexPreview(wasmBytes) {
  if (!wasmBytes || wasmBytes.length === 0) {
    return "No WebAssembly binary emitted.";
  }

  const bytes =
    wasmBytes instanceof Uint8Array ? wasmBytes : new Uint8Array(wasmBytes);
  const lines = [];

  // 1. Header check
  const magicHex = Array.from(bytes.slice(0, 4))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  const versionHex = Array.from(bytes.slice(4, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");

  lines.push(`=== WebAssembly Binary Header (${bytes.byteLength} bytes total) ===`);
  lines.push(`Magic   : ${magicHex} ("\\0asm")`);
  lines.push(`Version : ${versionHex} (v1)`);

  // 2. Parse top-level Wasm sections (best-effort ULEB128 scan)
  const sections = [];
  let offset = 8;
  while (offset < bytes.length) {
    const id = bytes[offset++];
    let len = 0;
    let shift = 0;
    while (offset < bytes.length) {
      const b = bytes[offset++];
      len |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    const secStart = offset;
    const secEnd = Math.min(bytes.length, secStart + len);
    sections.push({
      id,
      name: WASM_SECTION_NAMES[id] || `Section (${id})`,
      offset: secStart,
      byteLength: len,
    });
    offset = secEnd;
  }

  if (sections.length > 0) {
    lines.push("");
    lines.push("=== Emitted Wasm Sections ===");
    for (const s of sections) {
      const offStr = "0x" + s.offset.toString(16).padStart(4, "0");
      lines.push(
        `  [${s.name.padEnd(13)}] offset=${offStr}  size=${String(s.byteLength).padStart(4)} B`
      );
    }
  }

  // 3. Hex + ASCII Dump
  lines.push("");
  lines.push("=== Raw Bytecode Hex Preview ===");
  const maxBytes = Math.min(bytes.length, 4096);
  for (let i = 0; i < maxBytes; i += 16) {
    const addr = i.toString(16).padStart(4, "0");
    const rowBytes = bytes.slice(i, i + 16);
    const hexCols = [];
    let ascii = "";
    for (let j = 0; j < 16; j++) {
      if (j < rowBytes.length) {
        const b = rowBytes[j];
        hexCols.push(b.toString(16).padStart(2, "0"));
        ascii += b >= 32 && b <= 126 ? String.fromCharCode(b) : ".";
      } else {
        hexCols.push("  ");
        ascii += " ";
      }
    }
    const leftHex = hexCols.slice(0, 8).join(" ");
    const rightHex = hexCols.slice(8, 16).join(" ");
    lines.push(`${addr}:  ${leftHex}  ${rightHex}  |${ascii}|`);
  }

  if (bytes.length > maxBytes) {
    lines.push(`... (${bytes.length - maxBytes} more bytes truncated in preview)`);
  }

  return lines.join("\n");
}

/**
 * Format lowered LIR module into readable text for the LIR pane.
 */
function formatLirModule(lir) {
  if (!lir || !Array.isArray(lir.functions)) {
    return "No LIR module available.";
  }

  const out = [];
  if (Array.isArray(lir.stringLiterals) && lir.stringLiterals.length > 0) {
    out.push("// Static String Pool:");
    lir.stringLiterals.forEach((s, idx) => {
      const val = typeof s === "string" ? s : s?.value ?? "";
      out.push(`  const_str[${idx}] = ${JSON.stringify(val)}`);
    });
    out.push("");
  }

  for (const fn of lir.functions) {
    const params = (fn.params || [])
      .map((p) => `${p.name || "$" + p.id}: ${p.type}`)
      .join(", ");
    const ret = fn.returnType || "void";
    out.push(`fn ${fn.name}(${params}) -> ${ret} {`);
    if (Array.isArray(fn.locals) && fn.locals.length > 0) {
      for (const loc of fn.locals) {
        out.push(`  local $${loc.id} (${loc.name || "tmp"}): ${loc.type}`);
      }
    }
    for (const stmt of fn.body || []) {
      out.push("  " + formatLirStmt(stmt, 1));
    }
    out.push("}\n");
  }

  return out.join("\n");
}

function formatLirStmt(stmt, indent = 1) {
  if (!stmt) return "";
  const pad = "  ".repeat(indent);
  switch (stmt.op) {
    case "debug_loc":
      return `debug_loc line=${stmt.line}, col=${stmt.col}`;
    case "local_set":
      return `local_set $${stmt.localId} = ${formatLirExpr(stmt.value)}`;
    case "global_set":
      return `global_set @${stmt.name} = ${formatLirExpr(stmt.value)}`;
    case "mem_store":
      return `mem_store.${stmt.storeType} [${formatLirExpr(stmt.ptr)} + ${stmt.offset}] = ${formatLirExpr(stmt.value)}`;
    case "return":
      return stmt.value ? `return ${formatLirExpr(stmt.value)}` : "return";
    case "expr":
      return formatLirExpr(stmt.expr);
    case "trap":
      return `trap ${JSON.stringify(stmt.message || "unreachable")}`;
    case "br":
      return `br @${stmt.label}`;
    case "br_if":
      return `br_if ${formatLirExpr(stmt.cond)} -> @${stmt.label}`;
    case "if": {
      const lines = [`if (${formatLirExpr(stmt.cond)}) {`];
      for (const s of stmt.thenBody || []) {
        lines.push(`${pad}  ${formatLirStmt(s, indent + 1)}`);
      }
      if (stmt.elseBody && stmt.elseBody.length > 0) {
        lines.push(`${pad}} else {`);
        for (const s of stmt.elseBody) {
          lines.push(`${pad}  ${formatLirStmt(s, indent + 1)}`);
        }
      }
      lines.push(`${pad}}`);
      return lines.join("\n");
    }
    case "loop":
    case "block": {
      const lines = [`${stmt.op} @${stmt.label} {`];
      for (const s of stmt.body || []) {
        lines.push(`${pad}  ${formatLirStmt(s, indent + 1)}`);
      }
      lines.push(`${pad}}`);
      return lines.join("\n");
    }
    default:
      return JSON.stringify(stmt);
  }
}

function formatLirExpr(expr) {
  if (!expr) return "void";
  switch (expr.op) {
    case "const_i32":
    case "const_i64":
    case "const_f64":
      return `${expr.op}(${expr.value})`;
    case "const_string":
      return `const_string(#${expr.stringId})`;
    case "local_get":
      return `local_get($${expr.localId})`;
    case "global_get":
      return `global_get(@${expr.name})`;
    case "binop":
      return `(${formatLirExpr(expr.left)} ${expr.kind} ${formatLirExpr(expr.right)})`;
    case "unop":
      return `(${expr.kind} ${formatLirExpr(expr.operand)})`;
    case "conv":
      return `${expr.kind}(${formatLirExpr(expr.operand)})`;
    case "call":
      return `call ${expr.funcName}(${(expr.args || []).map(formatLirExpr).join(", ")})`;
    case "call_builtin":
      return `call_builtin ${expr.builtin}(${(expr.args || []).map(formatLirExpr).join(", ")})`;
    case "mem_load":
      return `mem_load.${expr.loadType}[${formatLirExpr(expr.ptr)} + ${expr.offset}]`;
    case "gc_alloc":
      return `gc_alloc(kind=${expr.objKind}, td=${expr.typeDescId}, size=${formatLirExpr(expr.payloadSize)})`;
    default:
      return expr.op || "expr";
  }
}

/**
 * Direct browser fallback runner using `WebAssembly.instantiate` if needed.
 * Reads UTF-8 string objects (header at +0, byte_len at +8, UTF-8 bytes at +12).
 */
async function instantiateAndRunWasmInBrowser(wasmBytes) {
  let stdout = "";
  let errorText = "";
  let exitCode = 0;
  let wasmMemory = null;
  const decoder = new TextDecoder("utf-8");

  function readHeapString(ptr) {
    if (!wasmMemory || !ptr) return "";
    const u8 = new Uint8Array(wasmMemory.buffer);
    const view = new DataView(wasmMemory.buffer);
    const byteLen = view.getUint32(ptr + 8, true);
    const start = ptr + 12;
    return decoder.decode(u8.subarray(start, start + byteLen));
  }

  const imports = {
    env: {
      __lumen_print_str(ptr) {
        stdout += readHeapString(ptr);
      },
      __lumen_println_str(ptr) {
        stdout += readHeapString(ptr) + "\n";
      },
      __lumen_print_i32(val) {
        stdout += String(val | 0);
      },
      __lumen_println_i32(val) {
        stdout += String(val | 0) + "\n";
      },
      __lumen_print_i64(val) {
        stdout += String(val);
      },
      __lumen_println_i64(val) {
        stdout += String(val) + "\n";
      },
      __lumen_print_f64(val) {
        stdout += formatFloat64(val);
      },
      __lumen_println_f64(val) {
        stdout += formatFloat64(val) + "\n";
      },
      __lumen_print_bool(val) {
        stdout += val ? "true" : "false";
      },
      __lumen_println_bool(val) {
        stdout += (val ? "true" : "false") + "\n";
      },
      __lumen_debug_step(_line, _col, _fnId, _shadowFp) {},
      __lumen_trap(msgPtr) {
        const msg = msgPtr ? readHeapString(msgPtr) : "unreachable";
        throw new LumenRuntimeError(msg);
      },
      __lumen_clock_ms() {
        return performance.now();
      },
    },
  };

  try {
    const bytes =
      wasmBytes instanceof Uint8Array ? wasmBytes : new Uint8Array(wasmBytes);
    const { instance } = await WebAssembly.instantiate(bytes, imports);
    wasmMemory = instance.exports.memory || null;
    const mainFn = instance.exports.main || instance.exports._start;
    let returnValue = null;
    if (typeof mainFn === "function") {
      returnValue = mainFn();
    }
    return {
      stdout,
      errorText,
      returnValue: returnValue ?? null,
      exitCode: 0,
    };
  } catch (err) {
    exitCode = 1;
    if (err instanceof LumenRuntimeError) {
      errorText = err.format();
    } else {
      errorText = `runtime error: ${err?.message || String(err)}`;
    }
    return {
      stdout,
      errorText,
      returnValue: null,
      exitCode,
    };
  }
}

class PlaygroundApp {
  constructor() {
    this.compilerMod = null;
    this.lastCompiledWasmBytes = null;
    this.activeFilename = "examples/hello.lm";
    this._checkTimer = null;

    this.editor = new LumenEditor({
      onChange: (source) => this._scheduleLiveCheck(source),
      onRunWasm: () => this.run("wasm"),
      onFormat: () => this.formatCode(),
    });

    this._bindDomElements();
    this._init();
  }

  _bindDomElements() {
    this.statusBadge = document.getElementById("compiler-status-badge");
    this.exampleSelect = document.getElementById("example-select");
    this.btnRunWasm = document.getElementById("btn-run-wasm");
    this.btnRunInterp = document.getElementById("btn-run-interp");
    this.btnFormat = document.getElementById("btn-format");
    this.btnClearOutput = document.getElementById("btn-clear-output");
    this.btnDownloadWasm = document.getElementById("btn-download-wasm");

    this.badgeCompileTime = document.getElementById("badge-compile-time");
    this.badgeWasmSize = document.getElementById("badge-wasm-size");
    this.badgeParity = document.getElementById("badge-parity");

    this.activeFilenameEl = document.getElementById("active-filename");
    this.outExecMode = document.getElementById("out-exec-mode");
    this.outWasmSize = document.getElementById("out-wasm-size");
    this.outExecTime = document.getElementById("out-exec-time");
    this.outExitCode = document.getElementById("out-exit-code");
    this.outParityBadge = document.getElementById("out-parity-badge");

    this.outputStdout = document.getElementById("output-stdout");
    this.outputDiagSection = document.getElementById("output-diagnostics-section");
    this.outputDiagPre = document.getElementById("output-diagnostics");

    this.wasmSecCount = document.getElementById("wasm-sec-count");
    this.wasmHexView = document.getElementById("wasm-hex-view");
    this.lirFnCount = document.getElementById("lir-fn-count");
    this.lirCodeView = document.getElementById("lir-code-view");
    this.irWasmGrid = document.getElementById("ir-wasm-grid");

    if (this.btnRunWasm) {
      this.btnRunWasm.addEventListener("click", () => this.run("wasm"));
    }
    if (this.btnRunInterp) {
      this.btnRunInterp.addEventListener("click", () => this.run("interp"));
    }
    if (this.btnFormat) {
      this.btnFormat.addEventListener("click", () => this.formatCode());
    }
    if (this.btnClearOutput) {
      this.btnClearOutput.addEventListener("click", () => {
        if (this.outputStdout) this.outputStdout.textContent = "";
      });
    }
    if (this.btnDownloadWasm) {
      this.btnDownloadWasm.addEventListener("click", () => this.downloadWasm());
    }
    if (this.exampleSelect) {
      this.exampleSelect.addEventListener("change", () => {
        this.loadSelectedExample(this.exampleSelect.value);
      });
    }

    // View mode sub-tabs (Split / Wasm Hex / LIR)
    document.querySelectorAll(".subtab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".subtab-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const view = btn.dataset.view;
        if (this.irWasmGrid) {
          this.irWasmGrid.classList.remove("view-lir", "view-wasm");
          if (view === "lir") this.irWasmGrid.classList.add("view-lir");
          if (view === "wasm") this.irWasmGrid.classList.add("view-wasm");
        }
      });
    });
  }

  async _init() {
    // 1. Load in-browser compiler module `/src/compiler.js`
    try {
      this.compilerMod = await import("/src/compiler.js");
      const sabReady = typeof SharedArrayBuffer !== "undefined";
      if (this.statusBadge) {
        this.statusBadge.textContent = sabReady
          ? "Client Wasm Ready (COOP/COEP)"
          : "Client Wasm Ready";
        this.statusBadge.className = "status-badge status-ready";
      }
    } catch (err) {
      console.warn("Direct browser import of /src/compiler.js failed, using /api/compile:", err);
      if (this.statusBadge) {
        this.statusBadge.textContent = "Server API Mode";
        this.statusBadge.className = "status-badge status-busy";
      }
    }

    // 2. Load `examples/hello.lm` and execute immediately
    await this.loadSelectedExample("hello");
  }

  async loadSelectedExample(name) {
    if (name === "diagnostics") {
      this.activeFilename = "diagnostics_demo.lm";
      if (this.activeFilenameEl) this.activeFilenameEl.textContent = this.activeFilename;
      this.editor.setValue(DIAGNOSTICS_DEMO_SOURCE);
      await this.run("wasm");
      return;
    }

    this.activeFilename = "examples/hello.lm";
    if (this.activeFilenameEl) this.activeFilenameEl.textContent = this.activeFilename;

    let source = HELLO_WORLD_SOURCE;
    try {
      const resp = await fetch("/api/examples/hello");
      if (resp.ok) {
        const data = await resp.json();
        if (data && typeof data.source === "string" && data.source.trim().length > 0) {
          source = data.source;
        }
      }
    } catch (_err) {
      // Fallback to built-in HELLO_WORLD_SOURCE
    }

    this.editor.setValue(source);
    await this.run("wasm");
  }

  _scheduleLiveCheck(source) {
    if (this._checkTimer) clearTimeout(this._checkTimer);
    this._checkTimer = setTimeout(() => {
      this._runLiveCheck(source);
    }, 180);
  }

  _runLiveCheck(source) {
    if (!this.compilerMod || typeof this.compilerMod.compileSource !== "function") {
      return;
    }
    try {
      const res = this.compilerMod.compileSource(source, {
        filename: this.activeFilename,
        checkOnly: true,
      });
      this.editor.setDiagnostics(res.diagnostics || []);
    } catch (_err) {
      // Ignore transient errors while typing
    }
  }

  async run(primaryMode = "wasm") {
    const source = this.editor.getValue();
    const filename = this.activeFilename;

    if (this.statusBadge) {
      this.statusBadge.textContent = "Compiling...";
      this.statusBadge.className = "status-badge status-busy";
    }

    let compileTimeMs = 0;
    let compiled = null;
    let wasmExec = null;
    let interpExec = null;

    try {
      if (this.compilerMod && typeof this.compilerMod.compileSource === "function") {
        // 100% In-Browser Compilation & WebAssembly Execution!
        const t0 = performance.now();
        compiled = this.compilerMod.compileSource(source, { filename });
        compileTimeMs = +(performance.now() - t0).toFixed(2);

        if (compiled.success && compiled.wasmBytes) {
          const tw0 = performance.now();
          try {
            if (typeof this.compilerMod.runSourceWasmAsync === "function") {
              wasmExec = await this.compilerMod.runSourceWasmAsync(source, { filename });
            } else if (typeof this.compilerMod.runSourceWasm === "function") {
              wasmExec = this.compilerMod.runSourceWasm(source, { filename });
            } else {
              wasmExec = await instantiateAndRunWasmInBrowser(compiled.wasmBytes);
            }
          } catch (_wasmRunnerErr) {
            wasmExec = await instantiateAndRunWasmInBrowser(compiled.wasmBytes);
          }
          wasmExec.execTimeMs = +(performance.now() - tw0).toFixed(2);

          const ti0 = performance.now();
          if (typeof this.compilerMod.runSourceInterp === "function") {
            interpExec = this.compilerMod.runSourceInterp(source, { filename });
            interpExec.execTimeMs = +(performance.now() - ti0).toFixed(2);
          }
        }
      } else {
        // Fallback to Server API
        const resp = await fetch("/api/compile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source, filename, mode: "both" }),
        });
        const data = await resp.json();
        if (!data.ok) {
          throw new Error(data.error || "Compilation request failed");
        }
        compileTimeMs = data.compileTimeMs || 0;
        compiled = data.compiled;
        if (compiled && Array.isArray(compiled.wasmBytes)) {
          compiled.wasmBytes = new Uint8Array(compiled.wasmBytes);
        }
        wasmExec = data.wasmExec;
        interpExec = data.interpExec;
      }

      this._renderResults({
        primaryMode,
        compileTimeMs,
        compiled,
        wasmExec,
        interpExec,
      });
    } catch (err) {
      if (this.statusBadge) {
        this.statusBadge.textContent = "Compile Error";
        this.statusBadge.className = "status-badge status-error";
      }
      if (this.outputDiagSection && this.outputDiagPre) {
        this.outputDiagSection.classList.remove("hidden");
        this.outputDiagPre.textContent = err?.stack || err?.message || String(err);
      }
    }
  }

  _renderResults({ primaryMode, compileTimeMs, compiled, wasmExec, interpExec }) {
    const diagnostics = compiled?.diagnostics || [];
    this.editor.setDiagnostics(diagnostics);

    if (this.badgeCompileTime) {
      this.badgeCompileTime.textContent = `Compile: ${compileTimeMs} ms`;
    }

    if (!compiled || !compiled.success) {
      this.lastCompiledWasmBytes = null;
      if (this.statusBadge) {
        this.statusBadge.textContent = "Diagnostics Found";
        this.statusBadge.className = "status-badge status-error";
      }
      if (this.badgeWasmSize) this.badgeWasmSize.textContent = "Wasm: 0 bytes";
      if (this.outWasmSize) this.outWasmSize.textContent = "Wasm Size: 0 bytes";
      if (this.wasmSecCount) this.wasmSecCount.textContent = "0 bytes";
      if (this.outExitCode) this.outExitCode.textContent = "Exit Code: 1";
      if (this.badgeParity) {
        this.badgeParity.textContent = "Parity: Compile Error";
        this.badgeParity.className = "metric-pill parity-mismatch";
      }
      if (this.outParityBadge) {
        this.outParityBadge.textContent = "Parity: Compile Error";
        this.outParityBadge.className = "summary-chip parity-mismatch";
      }
      if (this.outputStdout) {
        this.outputStdout.textContent = "(compilation failed — see diagnostics below)";
      }
      if (this.outputDiagSection && this.outputDiagPre) {
        this.outputDiagSection.classList.remove("hidden");
        this.outputDiagPre.textContent =
          compiled?.formattedDiagnostics ||
          diagnostics.map((d) => `[${d.code}] ${d.message}`).join("\n");
      }
      if (this.wasmHexView) {
        this.wasmHexView.textContent = "Fix compiler errors to emit WebAssembly binary.";
      }
      if (this.lirCodeView) {
        this.lirCodeView.textContent = "Fix compiler errors to inspect lowered LIR.";
      }
      return;
    }

    // Successful Compilation
    const wasmBytes =
      compiled.wasmBytes instanceof Uint8Array
        ? compiled.wasmBytes
        : new Uint8Array(compiled.wasmBytes || []);
    this.lastCompiledWasmBytes = wasmBytes;
    const byteLen = wasmBytes.byteLength;

    if (this.statusBadge) {
      this.statusBadge.textContent =
        typeof SharedArrayBuffer !== "undefined"
          ? "Client Wasm Ready (COOP/COEP)"
          : "Client Wasm Ready";
      this.statusBadge.className = "status-badge status-ready";
    }

    // Update Wasm binary size badges
    if (this.badgeWasmSize) {
      this.badgeWasmSize.textContent = `Wasm: ${byteLen} bytes`;
    }
    if (this.outWasmSize) {
      this.outWasmSize.textContent = `Wasm Size: ${byteLen} bytes`;
    }
    if (this.wasmSecCount) {
      this.wasmSecCount.textContent = `${byteLen} bytes`;
    }

    // Select active execution output (Wasm vs Interpreter)
    const activeExec = primaryMode === "interp" && interpExec ? interpExec : wasmExec;
    const engineLabel =
      primaryMode === "interp"
        ? "Engine: Reference Interpreter"
        : "Engine: WebAssembly (Browser)";

    if (this.outExecMode) {
      this.outExecMode.textContent = engineLabel;
    }
    if (this.outExecTime) {
      this.outExecTime.textContent = `Exec: ${activeExec?.execTimeMs ?? 0} ms`;
    }
    if (this.outExitCode) {
      this.outExitCode.textContent = `Exit Code: ${activeExec?.exitCode ?? 0}`;
    }

    // Stdout display
    if (this.outputStdout) {
      const outStr = activeExec?.stdout ?? "";
      this.outputStdout.textContent =
        outStr.length > 0 ? outStr : "(program completed with empty stdout)";
    }

    // Runtime error or warning diagnostics display
    const runtimeErr = activeExec?.errorText || "";
    if (runtimeErr || diagnostics.length > 0) {
      if (this.outputDiagSection && this.outputDiagPre) {
        this.outputDiagSection.classList.remove("hidden");
        const parts = [];
        if (compiled.formattedDiagnostics) parts.push(compiled.formattedDiagnostics);
        if (runtimeErr) parts.push(runtimeErr);
        this.outputDiagPre.textContent = parts.join("\n");
      }
    } else if (this.outputDiagSection && this.outputDiagPre) {
      this.outputDiagSection.classList.add("hidden");
      this.outputDiagPre.textContent = "";
    }

    // Wasm vs. Interpreter Parity Verification
    if (wasmExec && interpExec) {
      const stdoutMatch = (wasmExec.stdout || "") === (interpExec.stdout || "");
      const errMatch = (wasmExec.errorText || "") === (interpExec.errorText || "");
      const codeMatch = (wasmExec.exitCode ?? 0) === (interpExec.exitCode ?? 0);
      const parityOk = stdoutMatch && errMatch && codeMatch;

      if (this.badgeParity) {
        this.badgeParity.textContent = parityOk
          ? "Parity: PASS (Wasm == Interp)"
          : "Parity: MISMATCH";
        this.badgeParity.className = parityOk
          ? "metric-pill parity-ok"
          : "metric-pill parity-mismatch";
      }
      if (this.outParityBadge) {
        this.outParityBadge.textContent = parityOk
          ? "Parity: PASS (Wasm == Interpreter)"
          : "Parity: MISMATCH (Wasm != Interpreter)";
        this.outParityBadge.className = parityOk
          ? "summary-chip parity-ok"
          : "summary-chip parity-mismatch";
      }
    }

    // Render Wasm Hex Preview & Lowered LIR
    if (this.wasmHexView) {
      this.wasmHexView.textContent = formatWasmHexPreview(wasmBytes);
    }
    if (this.lirCodeView) {
      this.lirCodeView.textContent = formatLirModule(compiled.lir);
    }
    if (this.lirFnCount) {
      const fnCount = compiled.lir?.functions?.length || 0;
      this.lirFnCount.textContent = `${fnCount} function${fnCount === 1 ? "" : "s"}`;
    }
  }

  async formatCode() {
    const source = this.editor.getValue();
    try {
      if (this.compilerMod && typeof this.compilerMod.formatLumen === "function") {
        const res = this.compilerMod.formatLumen(source, this.activeFilename);
        const formatted =
          typeof res === "string" ? res : res?.formatted || res?.code || source;
        this.editor.setValue(formatted, true);
        return;
      }
      const resp = await fetch("/api/format", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, filename: this.activeFilename }),
      });
      const data = await resp.json();
      if (data.ok && typeof data.formatted === "string") {
        this.editor.setValue(data.formatted, true);
      }
    } catch (_err) {
      // Keep source unchanged if syntax errors prevent formatting
    }
  }

  downloadWasm() {
    if (!this.lastCompiledWasmBytes || this.lastCompiledWasmBytes.byteLength === 0) {
      return;
    }
    const blob = new Blob([this.lastCompiledWasmBytes], { type: "application/wasm" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = this.activeFilename.replace(/\.lm$/, "").split("/").pop() + ".wasm";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  window.lumenPlayground = new PlaygroundApp();
});
