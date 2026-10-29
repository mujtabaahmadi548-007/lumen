/**
 * Lumen Browser Playground Server (`playground/server.js`)
 * Zero-dependency Node `node:http` server serving the workspace on http://127.0.0.1:3000
 * (or configurable `process.env.PORT` / `--port`).
 *
 * Serves:
 *   - `/` and `/playground/*`      -> playground UI assets
 *   - `/src/*`                     -> compiler & runtime ES modules (direct browser `<script type="module">` import)
 *   - `/examples/*`                -> example `.lm` programs
 *   - `GET  /api/examples`         -> JSON map of all `examples/*.lm` files
 *   - `GET  /api/examples/hello`   -> JSON payload for `examples/hello.lm` (and any `/api/examples/:name`)
 *   - `POST /api/compile`          -> server-side compile + Wasm & Interpreter execution endpoint
 *   - `POST /api/format`           -> server-side code formatter endpoint
 *   - `GET  /api/shim/*.js`        -> browser ES module shims for `node:fs`, `node:path`, `node:url`, `node:perf_hooks`
 *
 * Includes `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp` headers so `SharedArrayBuffer` + `Atomics.wait` is ready.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "..");
const PLAYGROUND_DIR = __dirname;
const STDLIB_DIR = path.join(WORKSPACE_ROOT, "stdlib");
const EXAMPLES_DIR = path.join(WORKSPACE_ROOT, "examples");
const SRC_DIR = path.join(WORKSPACE_ROOT, "src");

const DEFAULT_HELLO_SOURCE = `fn main() {\n    println("Hello, World!");\n}\n`;

const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".lm": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
});

/**
 * Safely serialize objects that may contain BigInt, Map, Set, or Uint8Array.
 */
function safeJsonStringify(obj) {
  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (value instanceof Uint8Array) {
      return Array.from(value);
    }
    if (value instanceof Map) {
      return Object.fromEntries(value.entries());
    }
    if (value instanceof Set) {
      return Array.from(value.values());
    }
    return value;
  });
}

/**
 * Load all `.lm` files from a directory into a lookup dictionary.
 */
function loadLmDirectory(dirPath, prefix = "") {
  const files = {};
  const rawFiles = {};
  if (!fs.existsSync(dirPath)) {
    return { files, rawFiles };
  }
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".lm")) {
        const fullPath = path.join(dirPath, entry.name);
        const content = fs.readFileSync(fullPath, "utf8");
        const baseName = entry.name.slice(0, -3);
        rawFiles[entry.name] = content;
        files[entry.name] = content;
        files[baseName] = content;
        if (prefix) {
          files[`${prefix}/${entry.name}`] = content;
          files[`${prefix}/${baseName}`] = content;
          files[`./${prefix}/${entry.name}`] = content;
          if (prefix === "stdlib") {
            files[`std::${baseName}`] = content;
            files[`std/${baseName}`] = content;
            files[`std/${entry.name}`] = content;
          }
        }
        const relPath = path.relative(WORKSPACE_ROOT, fullPath).replace(/\\/g, "/");
        files[relPath] = content;
        files["/" + relPath] = content;
        files[fullPath.replace(/\\/g, "/")] = content;
        files[fullPath] = content;
      }
    }
  } catch (_err) {
    // Ignore read errors if directory is not yet populated
  }
  return { files, rawFiles };
}

/**
 * Build a virtual FS snapshot of `stdlib/*.lm` and `examples/*.lm` for the browser `node:fs` shim.
 */
function buildVirtualFsPayload() {
  const stdlib = loadLmDirectory(STDLIB_DIR, "stdlib");
  const examples = loadLmDirectory(EXAMPLES_DIR, "examples");
  return {
    files: { ...stdlib.files, ...examples.files },
    stdlibList: Object.keys(stdlib.rawFiles),
    examplesList: Object.keys(examples.rawFiles),
  };
}

/**
 * Serve dynamic browser shims for Node built-in modules (`node:fs`, `node:path`, `node:url`, `node:perf_hooks`)
 * so `/src/compiler.js` and its dependencies run natively as ES modules in the browser.
 */
function serveBrowserShim(shimName, res) {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (shimName === "fs.js") {
    const vfs = buildVirtualFsPayload();
    const js = `// Browser Virtual FS Shim for Lumen Playground
const VFS = ${JSON.stringify(vfs.files)};
const STDLIB_LIST = ${JSON.stringify(vfs.stdlibList)};
const EXAMPLES_LIST = ${JSON.stringify(vfs.examplesList)};

function normalizeKey(p) {
  if (!p) return "";
  let s = String(p).replace(/\\\\/g, "/").trim();
  if (VFS[s] !== undefined) return s;
  const stdIdx = s.lastIndexOf("stdlib/");
  if (stdIdx !== -1 && VFS[s.slice(stdIdx)] !== undefined) return s.slice(stdIdx);
  const exIdx = s.lastIndexOf("examples/");
  if (exIdx !== -1 && VFS[s.slice(exIdx)] !== undefined) return s.slice(exIdx);
  const base = s.split("/").pop();
  if (base && VFS[base] !== undefined) return base;
  if (base && VFS[base + ".lm"] !== undefined) return base + ".lm";
  return s;
}

export function registerVirtualFile(filePath, content) {
  if (!filePath) return;
  const norm = String(filePath).replace(/\\\\/g, "/");
  VFS[norm] = content;
  const base = norm.split("/").pop();
  if (base) {
    VFS[base] = content;
    if (base.endsWith(".lm")) {
      const stem = base.slice(0, -3);
      VFS[stem] = content;
      VFS["std::" + stem] = content;
      VFS["stdlib/" + base] = content;
    }
  }
}

export function existsSync(p) {
  const k = normalizeKey(p);
  if (VFS[k] !== undefined) return true;
  if (k.endsWith("stdlib") || k.endsWith("examples")) return true;
  return false;
}

export function readFileSync(p, _encoding) {
  const k = normalizeKey(p);
  if (VFS[k] !== undefined) return VFS[k];
  throw new Error("ENOENT: no such file or directory in browser VFS: " + p);
}

export function readdirSync(p) {
  const s = String(p || "").replace(/\\\\/g, "/");
  if (s.includes("stdlib")) return [...STDLIB_LIST];
  if (s.includes("examples")) return [...EXAMPLES_LIST];
  return [...STDLIB_LIST];
}

export function statSync(p) {
  const k = normalizeKey(p);
  const isFile = VFS[k] !== undefined;
  return {
    isFile: () => isFile,
    isDirectory: () => !isFile,
  };
}

export function writeFileSync(p, content) {
  registerVirtualFile(p, String(content));
}

export function mkdirSync() {}

const fsDefault = {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
  registerVirtualFile,
};

export default fsDefault;
`;
    res.writeHead(200);
    res.end(js);
    return;
  }

  if (shimName === "path.js") {
    const js = `// Browser Path Shim for Lumen Playground
export const sep = "/";
export const delimiter = ":";

function norm(p) {
  if (!p) return ".";
  const parts = String(p).replace(/\\\\/g, "/").split("/");
  const out = [];
  const isAbs = String(p).startsWith("/");
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbs) out.push("..");
    } else {
      out.push(part);
    }
  }
  const joined = (isAbs ? "/" : "") + out.join("/");
  return joined || (isAbs ? "/" : ".");
}

export function normalize(p) {
  return norm(p);
}

export function join(...segments) {
  return norm(segments.filter(Boolean).join("/"));
}

export function resolve(...segments) {
  let resolved = "";
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (!seg) continue;
    resolved = seg + (resolved ? "/" + resolved : "");
    if (String(seg).startsWith("/")) break;
  }
  return norm("/" + resolved);
}

export function dirname(p) {
  const s = norm(p);
  const idx = s.lastIndexOf("/");
  if (idx === -1) return ".";
  if (idx === 0) return "/";
  return s.slice(0, idx);
}

export function basename(p, ext) {
  const s = norm(p);
  const base = s.split("/").pop() || "";
  if (ext && base.endsWith(ext)) {
    return base.slice(0, base.length - ext.length);
  }
  return base;
}

export function extname(p) {
  const base = basename(p);
  const idx = base.lastIndexOf(".");
  return idx > 0 ? base.slice(idx) : "";
}

export function relative(from, to) {
  const f = resolve(from).split("/").filter(Boolean);
  const t = resolve(to).split("/").filter(Boolean);
  while (f.length && t.length && f[0] === t[0]) {
    f.shift();
    t.shift();
  }
  return [...f.map(() => ".."), ...t].join("/") || ".";
}

export function isAbsolute(p) {
  return String(p || "").startsWith("/");
}

const pathDefault = {
  sep,
  delimiter,
  normalize,
  join,
  resolve,
  dirname,
  basename,
  extname,
  relative,
  isAbsolute,
  posix: null,
};
pathDefault.posix = pathDefault;

export default pathDefault;
`;
    res.writeHead(200);
    res.end(js);
    return;
  }

  if (shimName === "url.js") {
    const js = `// Browser URL Shim for Lumen Playground
export function fileURLToPath(u) {
  if (!u) return "/";
  const s = typeof u === "string" ? u : u.href || String(u);
  try {
    const parsed = new URL(s, "http://localhost/");
    return parsed.pathname || "/";
  } catch {
    return String(s).replace(/^file:\\/\\//, "");
  }
}

export function pathToFileURL(p) {
  return new URL(String(p || "/"), "http://localhost/");
}

export default { fileURLToPath, pathToFileURL };
`;
    res.writeHead(200);
    res.end(js);
    return;
  }

  if (shimName === "perf.js") {
    const js = `// Browser Performance Shim for Lumen Playground
export const performance = globalThis.performance || { now: () => Date.now() };
export default { performance };
`;
    res.writeHead(200);
    res.end(js);
    return;
  }

  res.writeHead(404);
  res.end("// Unknown shim");
}

/**
 * Read request body as JSON.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLen = 0;
    req.on("data", (chunk) => {
      totalLen += chunk.length;
      if (totalLen > 10 * 1024 * 1024) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Handle HTTP requests.
 */
async function handleRequest(req, res) {
  // Cross-Origin Isolation headers required for SharedArrayBuffer + Atomics.wait (Rule 16)
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");

  // CORS headers for local convenience
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1:3000"}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  // 1. Browser Node-Builtin Shims
  if (req.method === "GET" && pathname.startsWith("/api/shim/")) {
    const shimName = pathname.slice("/api/shim/".length);
    serveBrowserShim(shimName, res);
    return;
  }

  // 2. GET /api/stdlib
  if (req.method === "GET" && pathname === "/api/stdlib") {
    const { files, rawFiles } = loadLmDirectory(STDLIB_DIR, "stdlib");
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(
      safeJsonStringify({
        ok: true,
        files,
        rawFiles,
      })
    );
    return;
  }

  // 3. GET /api/examples and GET /api/examples/:name (e.g. /api/examples/hello)
  if (req.method === "GET" && pathname === "/api/examples") {
    const { files, rawFiles } = loadLmDirectory(EXAMPLES_DIR, "examples");
    if (!rawFiles["hello.lm"]) {
      rawFiles["hello.lm"] = DEFAULT_HELLO_SOURCE;
      files["hello.lm"] = DEFAULT_HELLO_SOURCE;
      files["hello"] = DEFAULT_HELLO_SOURCE;
    }
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(
      safeJsonStringify({
        ok: true,
        files,
        rawFiles,
      })
    );
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/examples/")) {
    const requestedName = pathname.slice("/api/examples/".length).replace(/\.lm$/, "");
    const { files } = loadLmDirectory(EXAMPLES_DIR, "examples");
    const source =
      files[`${requestedName}.lm`] ||
      files[requestedName] ||
      (requestedName === "hello" ? DEFAULT_HELLO_SOURCE : null);

    if (source === null) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(safeJsonStringify({ ok: false, error: `Example '${requestedName}' not found` }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(
      safeJsonStringify({
        ok: true,
        name: `${requestedName}.lm`,
        source,
      })
    );
    return;
  }

  // 4. POST /api/compile
  if (req.method === "POST" && pathname === "/api/compile") {
    try {
      const body = await readJsonBody(req);
      const source = typeof body.source === "string" ? body.source : "";
      const debug = Boolean(body.debug);
      const gcStress = Boolean(body.gcStress);
      const filename = body.filename || "hello.lm";
      const runMode = body.mode || "both"; // "compile", "wasm", "interp", "both"

      const compilerMod = await import("../src/compiler.js");

      const t0 = performance.now();
      const compiled = compilerMod.compileSource(source, {
        filename,
        debug,
        gcStress,
      });
      const compileTimeMs = +(performance.now() - t0).toFixed(2);

      let wasmExec = null;
      let interpExec = null;

      if (compiled.success && (runMode === "wasm" || runMode === "both")) {
        const tw0 = performance.now();
        wasmExec = compilerMod.runSourceWasm(source, {
          filename,
          debug,
          gcStress,
        });
        wasmExec.execTimeMs = +(performance.now() - tw0).toFixed(2);
      }

      if (compiled.success && (runMode === "interp" || runMode === "both")) {
        const ti0 = performance.now();
        interpExec = compilerMod.runSourceInterp(source, {
          filename,
        });
        interpExec.execTimeMs = +(performance.now() - ti0).toFixed(2);
      }

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        safeJsonStringify({
          ok: true,
          compileTimeMs,
          compiled: {
            success: compiled.success,
            diagnostics: compiled.diagnostics,
            formattedDiagnostics: compiled.formattedDiagnostics,
            lir: compiled.lir,
            wasmBytes: compiled.wasmBytes ? Array.from(compiled.wasmBytes) : null,
            wasmSize: compiled.wasmBytes ? compiled.wasmBytes.byteLength : 0,
            debugInfo: compiled.debugInfo,
            memoryLayout: compiled.memoryLayout,
          },
          wasmExec,
          interpExec,
        })
      );
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        safeJsonStringify({
          ok: false,
          error: err && err.message ? err.message : String(err),
          stack: err && err.stack ? err.stack : null,
        })
      );
    }
    return;
  }

  // 5. POST /api/format
  if (req.method === "POST" && pathname === "/api/format") {
    try {
      const body = await readJsonBody(req);
      const source = typeof body.source === "string" ? body.source : "";
      const filename = body.filename || "hello.lm";
      const compilerMod = await import("../src/compiler.js");
      const formattedResult = compilerMod.formatLumen(source, filename);
      const formatted =
        typeof formattedResult === "string"
          ? formattedResult
          : formattedResult?.formatted || formattedResult?.code || source;

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(safeJsonStringify({ ok: true, formatted }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        safeJsonStringify({
          ok: false,
          error: err && err.message ? err.message : String(err),
        })
      );
    }
    return;
  }

  // 6. Static File Serving (`playground/`, `src/`, `examples/`, `stdlib/`)
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
    return;
  }

  let targetFile = null;
  if (
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname === "/playground" ||
    pathname === "/playground/"
  ) {
    targetFile = path.join(PLAYGROUND_DIR, "index.html");
  } else if (pathname.startsWith("/playground/")) {
    const rel = pathname.slice("/playground/".length);
    targetFile = path.resolve(PLAYGROUND_DIR, rel);
    if (!targetFile.startsWith(PLAYGROUND_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
  } else if (
    pathname.startsWith("/src/") ||
    pathname.startsWith("/stdlib/") ||
    pathname.startsWith("/examples/")
  ) {
    const rel = pathname.slice(1);
    targetFile = path.resolve(WORKSPACE_ROOT, rel);
    if (
      !targetFile.startsWith(SRC_DIR) &&
      !targetFile.startsWith(STDLIB_DIR) &&
      !targetFile.startsWith(EXAMPLES_DIR)
    ) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
  } else {
    // Allow top-level requests like `/styles.css`, `/app.js`, `/editor.js`
    const candidate = path.resolve(PLAYGROUND_DIR, pathname.slice(1));
    if (
      candidate.startsWith(PLAYGROUND_DIR) &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile()
    ) {
      targetFile = candidate;
    }
  }

  if (!targetFile || !fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`404 Not Found: ${pathname}`);
    return;
  }

  const ext = path.extname(targetFile).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  try {
    const data = fs.readFileSync(targetFile);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(data);
    }
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Internal Server Error: ${err.message}`);
  }
}

/**
 * Create and start the Playground HTTP server.
 */
export function startServer(options = {}) {
  const cliPortIdx = process.argv.indexOf("--port");
  const cliPort =
    cliPortIdx !== -1 && process.argv[cliPortIdx + 1]
      ? Number(process.argv[cliPortIdx + 1])
      : null;
  const port = options.port || cliPort || Number(process.env.PORT) || 3000;
  const host = options.host || process.env.HOST || "127.0.0.1";

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end(`Server error: ${err.message}`);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      const url = `http://${host}:${actualPort}`;
      if (!options.silent) {
        console.log(`========================================================`);
        console.log(`  Lumen Browser Playground (M1)`);
        console.log(`  Listening on: ${url}`);
        console.log(`========================================================`);
      }
      resolve({ server, port: actualPort, host, url });
    });
  });
}

// Auto-start if executed directly via `node playground/server.js`
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === path.resolve(__filename).toLowerCase();

if (isMain) {
  startServer().catch((err) => {
    console.error("Failed to start Lumen Playground Server:", err);
    process.exit(1);
  });
}
