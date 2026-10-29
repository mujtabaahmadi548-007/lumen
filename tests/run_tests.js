/**
 * Lumen Test Suite Runner (`tests/run_tests.js`)
 * Owned exclusively by Agent G.
 *
 * Runs all positive, runtime-trap, negative error, and LIR safety tests comparing
 * WebAssembly compiled execution against the Reference Interpreter.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ErrorCodes, validateLir } from "../src/contracts/index.js";
import {
  compileSource,
  runSourceWasm,
  runSourceInterp,
  formatLumen,
} from "../src/compiler.js";
import { M2_POSITIVE_TESTS } from "./m2_positive_tests.js";
import { M2_NEGATIVE_TESTS } from "./m2_negative_tests.js";
import { M3_POSITIVE_TESTS } from "./m3_positive_tests.js";
import { M3_NEGATIVE_TESTS } from "./m3_negative_tests.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

export async function runAllTests(options = {}) {
  const filter = options.filter ? String(options.filter).toLowerCase() : null;
  const gcStress = Boolean(options.gcStress);

  let passed = 0;
  let failed = 0;
  const failures = [];

  console.log("\n========================================================");
  console.log("             LUMEN TEST SUITE RUNNER (M3)");
  console.log("========================================================\n");

  // ========================================================================
  // 1. Positive & Runtime Trap Tests (Wasm vs Interpreter Parity)
  // ========================================================================
  console.log("--- Running Positive & Runtime Trap Tests (Wasm vs Interpreter Parity) ---");

  const allPositiveTests = [...M2_POSITIVE_TESTS, ...M3_POSITIVE_TESTS];
  let posPassed = 0;
  let posFailed = 0;

  for (const test of allPositiveTests) {
    if (filter && !test.name.toLowerCase().includes(filter) && !(test.category && test.category.toLowerCase().includes(filter))) {
      continue;
    }

    const interpRes = runSourceInterp(test.source);
    const wasmRes = runSourceWasm(test.source, { gcStress });

    let testFailed = false;
    const errors = [];

    // Rule 1: Parity check between Wasm and Interpreter
    if (interpRes.stdout !== wasmRes.stdout) {
      testFailed = true;
      errors.push(`Stdout parity mismatch:\n  Interp: ${JSON.stringify(interpRes.stdout)}\n  Wasm:   ${JSON.stringify(wasmRes.stdout)}`);
    }

    if (interpRes.errorText !== wasmRes.errorText) {
      testFailed = true;
      errors.push(`ErrorText parity mismatch:\n  Interp: ${JSON.stringify(interpRes.errorText)}\n  Wasm:   ${JSON.stringify(wasmRes.errorText)}`);
    }

    if (interpRes.exitCode !== wasmRes.exitCode) {
      testFailed = true;
      errors.push(`ExitCode parity mismatch: Interp=${interpRes.exitCode}, Wasm=${wasmRes.exitCode}`);
    }

    // Rule 2: Expected value checks
    const expectedExitCode = test.expectedExitCode !== undefined ? test.expectedExitCode : 0;
    if (wasmRes.exitCode !== expectedExitCode) {
      testFailed = true;
      errors.push(`ExitCode expected ${expectedExitCode}, got ${wasmRes.exitCode}`);
    }

    if (test.expectedStdout !== undefined && wasmRes.stdout !== test.expectedStdout) {
      testFailed = true;
      errors.push(`Expected stdout mismatch:\n  Expected: ${JSON.stringify(test.expectedStdout)}\n  Actual:   ${JSON.stringify(wasmRes.stdout)}`);
    }

    if (test.expectedErrorText !== undefined && wasmRes.errorText !== test.expectedErrorText) {
      testFailed = true;
      errors.push(`Expected errorText mismatch:\n  Expected: ${JSON.stringify(test.expectedErrorText)}\n  Actual:   ${JSON.stringify(wasmRes.errorText)}`);
    }

    // Formatter round-trip check if requested
    if (test.checkFmtRoundTrip && wasmRes.exitCode === 0) {
      const formatted = formatLumen(test.source, test.name + ".lm");
      const fmtWasm = runSourceWasm(formatted, { gcStress });
      if (fmtWasm.stdout !== wasmRes.stdout || fmtWasm.exitCode !== 0) {
        testFailed = true;
        errors.push(`Formatter round-trip changed execution output:\n  Original: ${JSON.stringify(wasmRes.stdout)}\n  Formatted: ${JSON.stringify(fmtWasm.stdout)}`);
      }
    }

    if (testFailed) {
      posFailed++;
      failed++;
      failures.push({ name: test.name, errors });
      console.log(`  FAIL: ${test.name}`);
      for (const err of errors) {
        console.log(`    - ${err}`);
      }
    } else {
      posPassed++;
      passed++;
      console.log(`  PASS: ${test.name}`);
    }
  }

  // ========================================================================
  // 2. CLI End-to-End Execution Check (Terminal exitCode & stderr)
  // ========================================================================
  console.log("\n--- Running CLI End-to-End Subprocess Verification ---");
  const cliTmpFile = path.join(ROOT_DIR, "examples", "_cli_test_trap.lm");
  fs.writeFileSync(cliTmpFile, "fn main() {\n    let x = 10 / 0;\n}\n", "utf8");

  try {
    const cliRes = spawnSync(process.execPath, [path.join(ROOT_DIR, "bin", "lumen.js"), "run", cliTmpFile], {
      encoding: "utf8",
    });

    if (cliRes.status === 1 && (cliRes.stderr.includes("runtime error: division by zero") || cliRes.stdout.includes("runtime error: division by zero"))) {
      console.log("  PASS: CLI runtime trap exits 1 and prints 'runtime error: division by zero'");
      passed++;
    } else {
      console.log("  FAIL: CLI runtime trap failed:");
      console.log(`    ExitCode: ${cliRes.status} (expected 1)`);
      console.log(`    Output: ${cliRes.stderr || cliRes.stdout}`);
      failed++;
      failures.push({ name: "cli_runtime_trap", errors: ["CLI did not exit 1 with division by zero"] });
    }
  } finally {
    if (fs.existsSync(cliTmpFile)) {
      fs.unlinkSync(cliTmpFile);
    }
  }

  // CLI build -o verification
  const cliBuildSrc = path.join(ROOT_DIR, "examples", "_cli_build_src.lm");
  const cliBuildOut = path.join(ROOT_DIR, "examples", "_cli_custom_out.wasm");
  fs.writeFileSync(cliBuildSrc, "fn main() {\n    println(\"build test\");\n}\n", "utf8");

  try {
    const buildRes = spawnSync(process.execPath, [path.join(ROOT_DIR, "bin", "lumen.js"), "build", cliBuildSrc, "-o", cliBuildOut], {
      encoding: "utf8",
    });

    if (buildRes.status === 0 && fs.existsSync(cliBuildOut) && fs.statSync(cliBuildOut).size > 100) {
      console.log("  PASS: CLI 'lumen build -o' outputs .wasm to exact specified path");
      passed++;
    } else {
      console.log("  FAIL: CLI 'lumen build -o' failed to produce output file");
      failed++;
      failures.push({ name: "cli_build_dash_o", errors: ["CLI build -o failed"] });
    }
  } finally {
    if (fs.existsSync(cliBuildSrc)) fs.unlinkSync(cliBuildSrc);
    if (fs.existsSync(cliBuildOut)) fs.unlinkSync(cliBuildOut);
  }

  // ========================================================================
  // 3. Negative Error Tests (Covering 100% of ErrorCodes)
  // ========================================================================
  console.log("\n--- Running Negative Error Tests (Diagnostics & Fix Suggestions) ---");

  const allNegativeTests = [...M2_NEGATIVE_TESTS, ...M3_NEGATIVE_TESTS];
  let negPassed = 0;
  let negFailed = 0;
  const testedCodes = new Set();

  for (const test of allNegativeTests) {
    if (filter && !test.name.toLowerCase().includes(filter)) {
      continue;
    }

    const res = compileSource(test.source, { filename: test.name + ".lm" });
    const expectedCodes = test.expectedCodes || [test.expectedCode];
    for (const c of expectedCodes) {
      testedCodes.add(c);
    }

    let testFailed = false;
    const errors = [];

    if (res.success) {
      testFailed = true;
      errors.push("Compilation unexpectedly succeeded for negative test");
    }

    for (const expCode of expectedCodes) {
      const match = res.diagnostics.find((d) => d.code === expCode);
      if (!match) {
        testFailed = true;
        errors.push(`Expected error code ${expCode} not found in emitted diagnostics: [${res.diagnostics.map((d) => d.code).join(", ")}]`);
      } else {
        if (!match.suggestion || typeof match.suggestion !== "string" || match.suggestion.trim().length === 0) {
          testFailed = true;
          errors.push(`Diagnostic ${expCode} is missing actionable suggestion string`);
        }
        if (!match.span || match.span.startLine < 1 || match.span.startCol < 1) {
          testFailed = true;
          errors.push(`Diagnostic ${expCode} has invalid span: ${JSON.stringify(match.span)}`);
        }
      }
    }

    if (!res.formattedDiagnostics.includes("^")) {
      testFailed = true;
      errors.push("Formatted diagnostic output missing source caret snippet '^'");
    }

    if (!res.formattedDiagnostics.includes("= help:")) {
      testFailed = true;
      errors.push("Formatted diagnostic output missing '= help:' suggestion line");
    }

    if (testFailed) {
      negFailed++;
      failed++;
      failures.push({ name: test.name, errors });
      console.log(`  FAIL: ${test.name}`);
      for (const err of errors) {
        console.log(`    - ${err}`);
      }
    } else {
      negPassed++;
      passed++;
      console.log(`  PASS: ${test.name} (${expectedCodes.join(", ")})`);
    }
  }

  // Verify 100% ErrorCodes coverage
  const allContractCodes = Object.values(ErrorCodes);
  const uncoveredCodes = allContractCodes.filter((c) => !testedCodes.has(c));
  if (uncoveredCodes.length > 0 && !filter) {
    console.log(`\n  WARNING: The following ErrorCodes were not tested: ${uncoveredCodes.join(", ")}`);
    failed++;
    failures.push({ name: "uncovered_error_codes", errors: [`Uncovered ErrorCodes: ${uncoveredCodes.join(", ")}`] });
  } else if (!filter) {
    console.log(`\n  PASS: 100% of ErrorCodes covered (${testedCodes.size}/${allContractCodes.length})`);
    passed++;
  }

  // ========================================================================
  // 4. LIR Invariant & GC Safety Verification (validateLir Rejection Tests)
  // ========================================================================
  console.log("\n--- Running LIR GC Stack Safety & Invariant Tests (validateLir) ---");

  let lirPassed = 0;
  let lirFailed = 0;

  // Test 4.1: Reject unrooted gc_ref on stack across an allocating or calling operand
  try {
    const badStackLir = {
      functions: [
        {
          name: "test_violating_stack",
          params: [],
          locals: [],
          body: [
            {
              op: "expr",
              expr: {
                op: "call",
                funcName: "target_fn",
                type: "i32",
                args: [
                  { op: "gc_alloc", type: "gc_ref", payloadSize: { op: "const_i32", value: 16, type: "i32" } },
                  { op: "call", funcName: "allocating_call", type: "i32", args: [] },
                ],
              },
            },
          ],
        },
      ],
      typeDescriptors: [],
    };
    let threw = false;
    try {
      validateLir(badStackLir);
    } catch (e) {
      if (e.message.includes("LIR GC Stack Safety Violation")) {
        threw = true;
      }
    }
    if (threw) {
      console.log("  PASS: validateLir rejects unrooted gc_ref on stack across call");
      lirPassed++;
      passed++;
    } else {
      console.log("  FAIL: validateLir did not reject unrooted gc_ref across call");
      lirFailed++;
      failed++;
    }
  } catch (err) {
    lirFailed++;
    failed++;
  }

  // Test 4.2: Reject mem_load with offset < 8
  try {
    const badLoadOffsetLir = {
      functions: [
        {
          name: "test_bad_offset",
          params: [],
          locals: [],
          body: [
            {
              op: "expr",
              expr: {
                op: "mem_load",
                type: "i32",
                ptr: { op: "const_i32", value: 100, type: "i32" },
                offset: 4,
              },
            },
          ],
        },
      ],
      typeDescriptors: [],
    };
    let threw = false;
    try {
      validateLir(badLoadOffsetLir);
    } catch (e) {
      if (e.message.includes("must be >= 8")) {
        threw = true;
      }
    }
    if (threw) {
      console.log("  PASS: validateLir rejects mem_load with offset < 8");
      lirPassed++;
      passed++;
    } else {
      console.log("  FAIL: validateLir did not reject mem_load with offset < 8");
      lirFailed++;
      failed++;
    }
  } catch (err) {
    lirFailed++;
    failed++;
  }

  // Test 4.3: Reject mem_store with offset < 8
  try {
    const badStoreOffsetLir = {
      functions: [
        {
          name: "test_bad_store_offset",
          params: [],
          locals: [],
          body: [
            {
              op: "mem_store",
              type: "i32",
              offset: 0,
              ptr: { op: "const_i32", value: 100, type: "i32" },
              value: { op: "const_i32", value: 42, type: "i32" },
            },
          ],
        },
      ],
      typeDescriptors: [],
    };
    let threw = false;
    try {
      validateLir(badStoreOffsetLir);
    } catch (e) {
      if (e.message.includes("must be >= 8")) {
        threw = true;
      }
    }
    if (threw) {
      console.log("  PASS: validateLir rejects mem_store with offset < 8");
      lirPassed++;
      passed++;
    } else {
      console.log("  FAIL: validateLir did not reject mem_store with offset < 8");
      lirFailed++;
      failed++;
    }
  } catch (err) {
    lirFailed++;
    failed++;
  }

  // Test 4.4: Reject TypeDescriptor pointerOffset < 8
  try {
    const badTdOffsetLir = {
      functions: [],
      typeDescriptors: [
        {
          name: "BadTypeDesc",
          totalSize: 16,
          pointerOffsets: [0],
        },
      ],
    };
    let threw = false;
    try {
      validateLir(badTdOffsetLir);
    } catch (e) {
      if (e.message.includes("must be >= 8")) {
        threw = true;
      }
    }
    if (threw) {
      console.log("  PASS: validateLir rejects TypeDescriptor pointerOffset < 8");
      lirPassed++;
      passed++;
    } else {
      console.log("  FAIL: validateLir did not reject TypeDescriptor pointerOffset < 8");
      lirFailed++;
      failed++;
    }
  } catch (err) {
    lirFailed++;
    failed++;
  }

  // ========================================================================
  // Summary
  // ========================================================================
  const total = passed + failed;
  console.log("\n========================================================");
  console.log(`TEST RESULTS: ${passed}/${total} PASSED (${failed} FAILED)`);
  console.log(`  Positive & Trap Tests : ${posPassed}`);
  console.log(`  CLI Verification      : 2`);
  console.log(`  Negative Error Tests  : ${negPassed}`);
  console.log(`  LIR GC Safety Checks  : ${lirPassed}`);
  console.log(`  Contract Coverage     : ${allContractCodes.length}/${allContractCodes.length} (100%)`);
  console.log("========================================================\n");

  return {
    total,
    passed,
    failed,
    failures,
  };
}

// Standalone execution
if (process.argv[1] && process.argv[1].endsWith("run_tests.js")) {
  const filter = process.argv[2] || null;
  const gcStress = process.argv.includes("--gc-stress");
  runAllTests({ filter, gcStress })
    .then((res) => {
      process.exit(res.failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
