/**
 * WebAssembly Binary Section Builders (`src/wasm/sections.js`)
 * Owned exclusively by Agent D.
 * Zero external dependencies.
 */

import { ByteBuffer, encodeU32 } from "./leb128.js";
import { WasmValType, SectionId, ExportKind, WasmOp } from "./opcodes.js";

export const WASM_MAGIC_AND_VERSION = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, // "\0asm"
  0x01, 0x00, 0x00, 0x00, // version 1
]);

/**
 * Wrap a section payload in `[sectionId, byteLength, ...payload]`.
 * Returns empty Uint8Array if payload is empty.
 */
export function encodeSection(sectionId, payloadBytes) {
  if (!payloadBytes || payloadBytes.length === 0) {
    return new Uint8Array(0);
  }
  const buf = new ByteBuffer(payloadBytes.length + 8);
  buf.writeByte(sectionId);
  buf.writeU32(payloadBytes.length);
  buf.writeBytes(payloadBytes);
  return buf.toUint8Array();
}

/**
 * Encode a function signature `0x60 [params...] [results...]`.
 */
export function encodeFuncType(paramTypes, returnTypes) {
  const buf = new ByteBuffer(16);
  buf.writeByte(WasmValType.FUNC_TYPE);
  buf.writeU32(paramTypes.length);
  for (let i = 0; i < paramTypes.length; i++) {
    buf.writeByte(paramTypes[i]);
  }
  buf.writeU32(returnTypes.length);
  for (let i = 0; i < returnTypes.length; i++) {
    buf.writeByte(returnTypes[i]);
  }
  return buf.toUint8Array();
}

/**
 * Section 1: Type Section
 * @param {Array<{ params: number[], results: number[] }>} funcTypes
 */
export function buildTypeSection(funcTypes) {
  if (!funcTypes || funcTypes.length === 0) return new Uint8Array(0);
  const payload = new ByteBuffer();
  payload.writeU32(funcTypes.length);
  for (const ft of funcTypes) {
    payload.writeBytes(encodeFuncType(ft.params, ft.results));
  }
  return encodeSection(SectionId.TYPE, payload.toUint8Array());
}

/**
 * Section 2: Import Section
 * @param {Array<{ module: string, name: string, kind: number, typeIndex: number }>} imports
 */
export function buildImportSection(imports) {
  if (!imports || imports.length === 0) return new Uint8Array(0);
  const payload = new ByteBuffer();
  payload.writeU32(imports.length);
  for (const imp of imports) {
    payload.writeString(imp.module);
    payload.writeString(imp.name);
    payload.writeByte(imp.kind ?? ExportKind.FUNC);
    payload.writeU32(imp.typeIndex);
  }
  return encodeSection(SectionId.IMPORT, payload.toUint8Array());
}

/**
 * Section 3: Function Section (maps defined function index -> type index)
 * @param {number[]} typeIndices
 */
export function buildFunctionSection(typeIndices) {
  if (!typeIndices || typeIndices.length === 0) return new Uint8Array(0);
  const payload = new ByteBuffer();
  payload.writeU32(typeIndices.length);
  for (let i = 0; i < typeIndices.length; i++) {
    payload.writeU32(typeIndices[i]);
  }
  return encodeSection(SectionId.FUNCTION, payload.toUint8Array());
}

/**
 * Section 4: Table Section (funcref table for `call_indirect`)
 * @param {number} minSize
 * @param {number | null} maxSize
 */
export function buildTableSection(minSize, maxSize = null) {
  const payload = new ByteBuffer(16);
  payload.writeU32(1); // 1 table
  payload.writeByte(WasmValType.FUNCREF);
  if (maxSize !== null && maxSize !== undefined) {
    payload.writeByte(0x01); // has max
    payload.writeU32(minSize);
    payload.writeU32(maxSize);
  } else {
    payload.writeByte(0x00); // min only
    payload.writeU32(minSize);
  }
  return encodeSection(SectionId.TABLE, payload.toUint8Array());
}

/**
 * Section 5: Memory Section
 * @param {number} minPages (64KB per page)
 * @param {number | null} maxPages
 */
export function buildMemorySection(minPages, maxPages = null) {
  const payload = new ByteBuffer(16);
  payload.writeU32(1); // 1 memory
  if (maxPages !== null && maxPages !== undefined) {
    payload.writeByte(0x01); // has max
    payload.writeU32(minPages);
    payload.writeU32(maxPages);
  } else {
    payload.writeByte(0x00); // min only
    payload.writeU32(minPages);
  }
  return encodeSection(SectionId.MEMORY, payload.toUint8Array());
}

/**
 * Section 6: Global Section
 * @param {Array<{ valType: number, mutable: boolean, initBytes: number[] | Uint8Array }>} globals
 */
export function buildGlobalSection(globals) {
  if (!globals || globals.length === 0) return new Uint8Array(0);
  const payload = new ByteBuffer();
  payload.writeU32(globals.length);
  for (const g of globals) {
    payload.writeByte(g.valType);
    payload.writeByte(g.mutable ? 0x01 : 0x00);
    payload.writeBytes(g.initBytes);
    payload.writeByte(WasmOp.end);
  }
  return encodeSection(SectionId.GLOBAL, payload.toUint8Array());
}

/**
 * Section 7: Export Section
 * @param {Array<{ name: string, kind: number, index: number }>} exports
 */
export function buildExportSection(exports) {
  if (!exports || exports.length === 0) return new Uint8Array(0);
  const payload = new ByteBuffer();
  payload.writeU32(exports.length);
  for (const exp of exports) {
    payload.writeString(exp.name);
    payload.writeByte(exp.kind);
    payload.writeU32(exp.index);
  }
  return encodeSection(SectionId.EXPORT, payload.toUint8Array());
}

/**
 * Section 9: Element Section (initializes funcref table starting at index 0)
 * @param {number[]} funcIndices
 */
export function buildElementSection(funcIndices) {
  if (!funcIndices || funcIndices.length === 0) return new Uint8Array(0);
  const payload = new ByteBuffer();
  payload.writeU32(1); // 1 element segment
  payload.writeByte(0x00); // active segment for table 0
  payload.writeByte(WasmOp.i32_const);
  payload.writeS32(0); // start at table index 0
  payload.writeByte(WasmOp.end);
  payload.writeU32(funcIndices.length);
  for (let i = 0; i < funcIndices.length; i++) {
    payload.writeU32(funcIndices[i]);
  }
  return encodeSection(SectionId.ELEMENT, payload.toUint8Array());
}

/**
 * Compress a flat array of Wasm local value types `[0x7f, 0x7f, 0x7e]`
 * into run-length encoded pairs `[{ count: 2, valType: 0x7f }, { count: 1, valType: 0x7e }]`.
 */
export function compressLocals(localValTypes) {
  if (!localValTypes || localValTypes.length === 0) return [];
  const runs = [];
  let curType = localValTypes[0];
  let count = 1;
  for (let i = 1; i < localValTypes.length; i++) {
    if (localValTypes[i] === curType) {
      count++;
    } else {
      runs.push({ count, valType: curType });
      curType = localValTypes[i];
      count = 1;
    }
  }
  runs.push({ count, valType: curType });
  return runs;
}

/**
 * Section 10: Code Section
 * @param {Array<{ localTypes: number[], bodyBytes: Uint8Array | number[] }>} funcBodies
 */
export function buildCodeSection(funcBodies) {
  if (!funcBodies || funcBodies.length === 0) return new Uint8Array(0);
  const payload = new ByteBuffer(1024);
  payload.writeU32(funcBodies.length);

  for (const fb of funcBodies) {
    const runs = compressLocals(fb.localTypes || []);
    const funcBuf = new ByteBuffer((fb.bodyBytes?.length || 0) + 32);
    funcBuf.writeU32(runs.length);
    for (const r of runs) {
      funcBuf.writeU32(r.count);
      funcBuf.writeByte(r.valType);
    }
    funcBuf.writeBytes(fb.bodyBytes);
    funcBuf.writeByte(WasmOp.end);

    const encodedBody = funcBuf.toUint8Array();
    payload.writeU32(encodedBody.length);
    payload.writeBytes(encodedBody);
  }

  return encodeSection(SectionId.CODE, payload.toUint8Array());
}

/**
 * Section 11: Data Section
 * @param {Array<{ offset: number, bytes: Uint8Array | number[] }>} segments
 */
export function buildDataSection(segments) {
  if (!segments || segments.length === 0) return new Uint8Array(0);
  const nonEmpty = segments.filter((s) => s.bytes && s.bytes.length > 0);
  if (nonEmpty.length === 0) return new Uint8Array(0);

  const payload = new ByteBuffer(512);
  payload.writeU32(nonEmpty.length);
  for (const seg of nonEmpty) {
    payload.writeByte(0x00); // active segment for memory 0
    payload.writeByte(WasmOp.i32_const);
    payload.writeS32(seg.offset);
    payload.writeByte(WasmOp.end);
    payload.writeU32(seg.bytes.length);
    payload.writeBytes(seg.bytes);
  }
  return encodeSection(SectionId.DATA, payload.toUint8Array());
}

/**
 * Assemble a complete WebAssembly binary module (`\0asm\x01\0\0\0` + ordered sections).
 * @param {Uint8Array[]} encodedSections
 * @returns {Uint8Array}
 */
export function assembleWasmModule(encodedSections) {
  let totalLen = WASM_MAGIC_AND_VERSION.length;
  for (const sec of encodedSections) {
    if (sec && sec.length > 0) {
      totalLen += sec.length;
    }
  }
  const out = new Uint8Array(totalLen);
  out.set(WASM_MAGIC_AND_VERSION, 0);
  let offset = WASM_MAGIC_AND_VERSION.length;
  for (const sec of encodedSections) {
    if (sec && sec.length > 0) {
      out.set(sec, offset);
      offset += sec.length;
    }
  }
  return out;
}
