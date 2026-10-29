#!/usr/bin/env node
/**
 * Lumen CLI (`bin/lumen.js`)
 * Commands:
 *   lumen build <file.lm> [-o <output.wasm>] [-O0|-O2] [--gc-stress]
 *   lumen run <file.lm> [--interp] [-O0|-O2] [--gc-stress]
 *   lumen test [filter] [--gc-stress]
 *   lumen fmt <file.lm> [--write] [--check]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileSource,
  runSourceWasm,
  runSourceInterp,
  formatLumen,
} from "../src/compiler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

function printUsage() {
  console.log(`Lumen Language Toolchain v1.0.0
Usage:
  lumen build <file.lm> [-o <out.wasm>] [-O0|-O2] [--gc-stress]   Compile Lumen source to raw WebAssembly (.wasm)
  lumen run   <file.lm> [--interp] [-O0|-O2] [--gc-stress]        Compile & execute Lumen source (Wasm or Interpreter)
  lumen test  [filter] [--gc-stress]                              Run the Lumen test suite (Wasm + Interpreter parity)
  lumen fmt   <file.lm> [--write] [--check]                       Format Lumen source code
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    process.exit(0);
  }

  const command = args[0];
  const rest = args.slice(1);

  if (command === "build") {
    let inputFile = null;
    let outputFile = null;
    let optLevel = 0;
    let gcStress = false;

    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if ((a === "-o" || a === "--output") && i + 1 < rest.length) {
        outputFile = rest[++i];
      } else if (a.startsWith("-o=")) {
        outputFile = a.slice(3);
      } else if (a.startsWith("--output=")) {
        outputFile = a.slice(9);
      } else if (a.startsWith("-o") && a.length > 2 && !a.startsWith("-O")) {
        outputFile = a.slice(2);
      } else if (a === "-O0") {
        optLevel = 0;
      } else if (a === "-O1") {
        optLevel = 1;
      } else if (a === "-O2" || a === "-O") {
        optLevel = 2;
      } else if (a === "--gc-stress") {
        gcStress = true;
      } else if (!a.startsWith("-")) {
        inputFile = a;
      }
    }

    if (!inputFile) {
      console.error("error: `lumen build` requires an input .lm file");
      process.exit(1);
    }

    const absInput = path.resolve(process.cwd(), inputFile);
    if (!fs.existsSync(absInput)) {
      console.error(`error: file not found: ${inputFile}`);
      process.exit(1);
    }

    const source = fs.readFileSync(absInput, "utf8");
    const result = compileSource(source, {
      filename: inputFile,
      baseDir: path.dirname(absInput),
      optLevel,
      gcStress,
    });

    if (!result.success) {
      console.error(result.formattedDiagnostics);
      process.exit(1);
    }

    const outPath = outputFile
      ? path.resolve(process.cwd(), outputFile)
      : absInput.replace(/\.lm$/, "") + ".wasm";

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, result.wasmBytes);
    const displayPath = outputFile || path.relative(process.cwd(), outPath);
    console.log(
      `Compiled ${inputFile} -> ${displayPath} (${result.wasmBytes.length} bytes)`
    );
    process.exit(0);
  }

  if (command === "run") {
    let inputFile = null;
    let useInterp = false;
    let optLevel = 0;
    let gcStress = false;

    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--interp") {
        useInterp = true;
      } else if (a === "-O0") {
        optLevel = 0;
      } else if (a === "-O1") {
        optLevel = 1;
      } else if (a === "-O2" || a === "-O") {
        optLevel = 2;
      } else if (a === "--gc-stress") {
        gcStress = true;
      } else if (!a.startsWith("-")) {
        inputFile = a;
      }
    }

    if (!inputFile) {
      console.error("error: `lumen run` requires an input .lm file");
      process.exit(1);
    }

    const absInput = path.resolve(process.cwd(), inputFile);
    if (!fs.existsSync(absInput)) {
      console.error(`error: file not found: ${inputFile}`);
      process.exit(1);
    }

    const source = fs.readFileSync(absInput, "utf8");
    const opts = {
      filename: inputFile,
      baseDir: path.dirname(absInput),
      optLevel,
      gcStress,
    };

    const result = useInterp
      ? runSourceInterp(source, opts)
      : runSourceWasm(source, opts);

    if (result.stdout) {
      process.stdout.write(result.stdout);
    }

    if (!result.success) {
      if (result.formattedDiagnostics) {
        console.error(result.formattedDiagnostics);
      }
      if (result.errorText) {
        console.error(result.errorText);
      }
      process.exit(result.exitCode || 1);
    }

    process.exit(0);
  }

  if (command === "fmt") {
    let inputFile = null;
    let writeInPlace = false;
    let checkOnly = false;

    for (const a of rest) {
      if (a === "--write" || a === "-w") writeInPlace = true;
      else if (a === "--check") checkOnly = true;
      else if (!a.startsWith("-")) inputFile = a;
    }

    if (!inputFile) {
      console.error("error: `lumen fmt` requires an input .lm file");
      process.exit(1);
    }

    const absInput = path.resolve(process.cwd(), inputFile);
    if (!fs.existsSync(absInput)) {
      console.error(`error: file not found: ${inputFile}`);
      process.exit(1);
    }

    const source = fs.readFileSync(absInput, "utf8");
    const formatted = formatLumen(source, inputFile);

    if (checkOnly) {
      if (formatted !== source) {
        console.error(`${inputFile}: needs formatting`);
        process.exit(1);
      }
      process.exit(0);
    }

    if (writeInPlace) {
      fs.writeFileSync(absInput, formatted, "utf8");
      console.log(`Formatted ${inputFile}`);
    } else {
      process.stdout.write(formatted);
    }
    process.exit(0);
  }

  if (command === "test") {
    const testRunnerPath = path.join(ROOT_DIR, "tests", "run_tests.js");
    if (!fs.existsSync(testRunnerPath)) {
      console.error("error: test runner not yet created at tests/run_tests.js");
      process.exit(1);
    }
    const { runAllTests } = await import(
      new URL("../tests/run_tests.js", import.meta.url).href
    );
    const gcStress = rest.includes("--gc-stress");
    const filter = rest.find((a) => !a.startsWith("-")) || null;
    const summary = await runAllTests({ filter, gcStress });
    process.exit(summary.failed > 0 ? 1 : 0);
  }

  console.error(`error: unknown command '${command}'`);
  printUsage();
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
