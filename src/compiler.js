/**
 * Lumen Compiler Pipeline Coordinator (`src/compiler.js`)
 * Owned exclusively by the Lead Engineer.
 * Orchestrates Agent A (Frontend), Agent B (TypeChecker), Agent C (LIR),
 * Agent D (Wasm Emitter/Runner), and Agent E (Reference Interpreter).
 */

import { validateLir } from "./contracts/index.js";
import { tokenize } from "./frontend/lexer.js";
import { parse } from "./frontend/parser.js";
import { formatSource } from "./frontend/formatter.js";
import { renderDiagnostics } from "./frontend/diagnostics.js";
import { typecheck } from "./typechecker/infer.js";
import { lowerToLir } from "./ir/lower.js";
import { emitWasm } from "./wasm/emitter.js";
import { runWasmSync, runWasm } from "./wasm/runner.js";
import { interpret } from "./interp/interpreter.js";

/**
 * Compile Lumen source code through the pipeline:
 * Lex -> Parse (with Error Recovery) -> Typecheck (runs even on recovered AST) -> LIR -> validateLir() -> Wasm Emit.
 */
export function compileSource(source, options = {}) {
  const filename = options.filename || "<input>";
  const debug = Boolean(options.debug);
  const gcStress = Boolean(options.gcStress);
  const sourceMap = new Map([[filename, source]]);

  // 1. Lexer
  const lexResult = tokenize(source, filename);
  if (lexResult.diagnostics.length > 0 && options.stopOnLexError) {
    return {
      success: false,
      diagnostics: lexResult.diagnostics,
      formattedDiagnostics: renderDiagnostics(lexResult.diagnostics, sourceMap),
      tokens: lexResult.tokens,
      ast: null,
      lir: null,
      wasmBytes: null,
      debugInfo: null,
    };
  }

  // 2. Parser (with Error Recovery: produces recovered AST even when syntax errors occur)
  const parseResult = parse(lexResult.tokens, filename, source);
  const allDiagnostics = [...lexResult.diagnostics, ...parseResult.diagnostics];

  if (!parseResult.ast) {
    return {
      success: false,
      diagnostics: allDiagnostics,
      formattedDiagnostics: renderDiagnostics(allDiagnostics, sourceMap),
      tokens: lexResult.tokens,
      ast: null,
      lir: null,
      wasmBytes: null,
      debugInfo: null,
    };
  }

  // 3. Type Checker (runs on recovered AST so syntax + type errors are both reported in one pass)
  const tcResult = typecheck(parseResult.ast, { filename, sourceMap });
  allDiagnostics.push(...tcResult.diagnostics);

  if (allDiagnostics.some((d) => d.severity === "error")) {
    return {
      success: false,
      diagnostics: allDiagnostics,
      formattedDiagnostics: renderDiagnostics(allDiagnostics, sourceMap),
      tokens: lexResult.tokens,
      ast: tcResult.ast || parseResult.ast,
      lir: null,
      wasmBytes: null,
      debugInfo: null,
    };
  }

  if (options.checkOnly) {
    return {
      success: true,
      diagnostics: allDiagnostics,
      formattedDiagnostics: renderDiagnostics(allDiagnostics, sourceMap),
      tokens: lexResult.tokens,
      ast: tcResult.ast,
      env: tcResult.env,
      lir: null,
      wasmBytes: null,
      debugInfo: null,
    };
  }

  // 4. Lower Typed AST -> LIR & Validate LIR Contract
  const lirModule = lowerToLir(tcResult.ast, {
    env: tcResult.env,
    debug,
  });
  validateLir(lirModule);

  // 5. Raw WebAssembly Binary Emission
  const wasmResult = emitWasm(lirModule, { debug, gcStress });

  return {
    success: true,
    diagnostics: allDiagnostics,
    formattedDiagnostics: renderDiagnostics(allDiagnostics, sourceMap),
    tokens: lexResult.tokens,
    ast: tcResult.ast,
    env: tcResult.env,
    lir: lirModule,
    wasmBytes: wasmResult.wasmBytes,
    debugInfo: wasmResult.debugInfo,
    memoryLayout: wasmResult.memoryLayout,
  };
}

/**
 * Compile and execute Lumen source via WebAssembly synchronously.
 */
export function runSourceWasm(source, options = {}) {
  const compiled = compileSource(source, options);
  if (!compiled.success) {
    return {
      success: false,
      diagnostics: compiled.diagnostics,
      formattedDiagnostics: compiled.formattedDiagnostics,
      stdout: "",
      errorText: "",
      returnValue: null,
      exitCode: 1,
    };
  }
  const execResult = runWasmSync(compiled.wasmBytes, {
    debugInfo: compiled.debugInfo,
    debugHooks: options.debugHooks || null,
    gcStress: Boolean(options.gcStress),
    args: options.args || [],
  });
  return {
    success: execResult.exitCode === 0,
    diagnostics: compiled.diagnostics,
    formattedDiagnostics: compiled.formattedDiagnostics,
    stdout: execResult.stdout || "",
    errorText: execResult.errorText || "",
    returnValue: execResult.returnValue,
    exitCode: execResult.exitCode,
    wasmBytes: compiled.wasmBytes,
    debugInfo: compiled.debugInfo,
    lir: compiled.lir,
  };
}

/**
 * Compile and execute Lumen source via WebAssembly asynchronously.
 */
export async function runSourceWasmAsync(source, options = {}) {
  const compiled = compileSource(source, options);
  if (!compiled.success) {
    return {
      success: false,
      diagnostics: compiled.diagnostics,
      formattedDiagnostics: compiled.formattedDiagnostics,
      stdout: "",
      errorText: "",
      returnValue: null,
      exitCode: 1,
    };
  }
  const execResult = await runWasm(compiled.wasmBytes, {
    debugInfo: compiled.debugInfo,
    debugHooks: options.debugHooks || null,
    gcStress: Boolean(options.gcStress),
    args: options.args || [],
  });
  return {
    success: execResult.exitCode === 0,
    diagnostics: compiled.diagnostics,
    formattedDiagnostics: compiled.formattedDiagnostics,
    stdout: execResult.stdout || "",
    errorText: execResult.errorText || "",
    returnValue: execResult.returnValue,
    exitCode: execResult.exitCode,
    wasmBytes: compiled.wasmBytes,
    debugInfo: compiled.debugInfo,
    lir: compiled.lir,
  };
}

/**
 * Parse, typecheck, and execute Lumen source via the independent Reference Interpreter.
 */
export function runSourceInterp(source, options = {}) {
  const compiled = compileSource(source, { ...options, checkOnly: true });
  if (!compiled.success) {
    return {
      success: false,
      diagnostics: compiled.diagnostics,
      formattedDiagnostics: compiled.formattedDiagnostics,
      stdout: "",
      errorText: "",
      returnValue: null,
      exitCode: 1,
    };
  }
  const interpResult = interpret(compiled.ast, {
    env: compiled.env,
    args: options.args || [],
  });
  return {
    success: interpResult.exitCode === 0,
    diagnostics: compiled.diagnostics,
    formattedDiagnostics: compiled.formattedDiagnostics,
    stdout: interpResult.stdout || "",
    errorText: interpResult.errorText || "",
    returnValue: interpResult.returnValue,
    exitCode: interpResult.exitCode,
  };
}

/**
 * Format Lumen source code (`lumen fmt`).
 */
export function formatLumen(source, filename = "<input>") {
  return formatSource(source, filename);
}
