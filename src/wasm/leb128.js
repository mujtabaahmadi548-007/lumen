/**
 * WebAssembly LEB128 Variable-Length Integer & Primitive Encoder (`src/wasm/leb128.js`)
 * Owned exclusively by Agent D.
 * Zero external dependencies.
 */

const textEncoder = new TextEncoder();
const f64Buffer = new ArrayBuffer(8);
const f64View = new DataView(f64Buffer);
const f64Bytes = new Uint8Array(f64Buffer);

/**
 * Encode an unsigned 32-bit integer in unsigned LEB128 format.
 * @param {number} val
 * @returns {number[]}
 */
export function encodeU32(val) {
  let v = val >>> 0;
  const out = [];
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (v !== 0);
  return out;
}

/**
 * Encode a signed 32-bit integer in signed LEB128 format.
 * Correctly handles negative numbers including -1 and -2147483648.
 * @param {number} val
 * @returns {number[]}
 */
export function encodeS32(val) {
  let v = val | 0;
  const out = [];
  while (true) {
    const byte = v & 0x7f;
    v >>= 7;
    if (
      (v === 0 && (byte & 0x40) === 0) ||
      (v === -1 && (byte & 0x40) !== 0)
    ) {
      out.push(byte);
      break;
    }
    out.push(byte | 0x80);
  }
  return out;
}

/**
 * Encode a signed 64-bit integer (BigInt or number) in signed LEB128 format.
 * @param {bigint | number} bigIntVal
 * @returns {number[]}
 */
export function encodeS64(bigIntVal) {
  let v = BigInt.asIntN(
    64,
    typeof bigIntVal === "bigint" ? bigIntVal : BigInt(Math.trunc(Number(bigIntVal) || 0))
  );
  const out = [];
  while (true) {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    if (
      (v === 0n && (byte & 0x40) === 0) ||
      (v === -1n && (byte & 0x40) !== 0)
    ) {
      out.push(byte);
      break;
    }
    out.push(byte | 0x80);
  }
  return out;
}

/**
 * Encode a 64-bit IEEE 754 float in little-endian 8-byte format.
 * @param {number} numVal
 * @returns {number[]}
 */
export function encodeF64(numVal) {
  f64View.setFloat64(0, Number(numVal), true);
  return [
    f64Bytes[0],
    f64Bytes[1],
    f64Bytes[2],
    f64Bytes[3],
    f64Bytes[4],
    f64Bytes[5],
    f64Bytes[6],
    f64Bytes[7],
  ];
}

/**
 * Encode a UTF-8 string into raw UTF-8 bytes (`Uint8Array`).
 * @param {string} str
 * @returns {Uint8Array}
 */
export function stringToUtf8(str) {
  return textEncoder.encode(String(str));
}

/**
 * Encode a length-prefixed UTF-8 string for Wasm binary format.
 * @param {string} str
 * @returns {number[]}
 */
export function encodeString(str) {
  const utf8 = textEncoder.encode(String(str));
  const out = encodeU32(utf8.length);
  for (let i = 0; i < utf8.length; i++) {
    out.push(utf8[i]);
  }
  return out;
}

/**
 * Encode a vector of byte arrays (`[count, ...elements]`).
 * @param {Array<number[] | Uint8Array>} byteArrays
 * @returns {number[]}
 */
export function encodeVec(byteArrays) {
  const buf = new ByteBuffer();
  buf.writeU32(byteArrays.length);
  for (let i = 0; i < byteArrays.length; i++) {
    buf.writeBytes(byteArrays[i]);
  }
  return buf.toArray();
}

/**
 * Fast growable byte buffer for WebAssembly binary emission.
 */
export class ByteBuffer {
  constructor(initialCapacity = 256) {
    this.buf = new Uint8Array(initialCapacity);
    this.len = 0;
  }

  get length() {
    return this.len;
  }

  ensureCapacity(extra) {
    const needed = this.len + extra;
    if (needed <= this.buf.length) return;
    let nextCap = this.buf.length * 2;
    while (nextCap < needed) {
      nextCap *= 2;
    }
    const nextBuf = new Uint8Array(nextCap);
    nextBuf.set(this.buf.subarray(0, this.len), 0);
    this.buf = nextBuf;
  }

  writeByte(b) {
    this.ensureCapacity(1);
    this.buf[this.len++] = b & 0xff;
    return this;
  }

  u8(b) {
    return this.writeByte(b);
  }

  writeBytes(bytes) {
    if (!bytes || bytes.length === 0) return this;
    const n = bytes.length;
    this.ensureCapacity(n);
    if (bytes instanceof Uint8Array) {
      this.buf.set(bytes, this.len);
      this.len += n;
    } else {
      for (let i = 0; i < n; i++) {
        this.buf[this.len++] = bytes[i] & 0xff;
      }
    }
    return this;
  }

  bytes(bytes) {
    return this.writeBytes(bytes);
  }

  writeU32(val) {
    let v = val >>> 0;
    this.ensureCapacity(5);
    do {
      let byte = v & 0x7f;
      v >>>= 7;
      if (v !== 0) {
        byte |= 0x80;
      }
      this.buf[this.len++] = byte;
    } while (v !== 0);
    return this;
  }

  u32(val) {
    return this.writeU32(val);
  }

  writeS32(val) {
    let v = val | 0;
    this.ensureCapacity(5);
    while (true) {
      const byte = v & 0x7f;
      v >>= 7;
      if (
        (v === 0 && (byte & 0x40) === 0) ||
        (v === -1 && (byte & 0x40) !== 0)
      ) {
        this.buf[this.len++] = byte;
        break;
      }
      this.buf[this.len++] = byte | 0x80;
    }
    return this;
  }

  s32(val) {
    return this.writeS32(val);
  }

  writeS64(bigIntVal) {
    let v = BigInt.asIntN(
      64,
      typeof bigIntVal === "bigint" ? bigIntVal : BigInt(Math.trunc(Number(bigIntVal) || 0))
    );
    this.ensureCapacity(10);
    while (true) {
      const byte = Number(v & 0x7fn);
      v >>= 7n;
      if (
        (v === 0n && (byte & 0x40) === 0) ||
        (v === -1n && (byte & 0x40) !== 0)
      ) {
        this.buf[this.len++] = byte;
        break;
      }
      this.buf[this.len++] = byte | 0x80;
    }
    return this;
  }

  s64(val) {
    return this.writeS64(val);
  }

  writeF64(numVal) {
    this.ensureCapacity(8);
    f64View.setFloat64(0, Number(numVal), true);
    this.buf.set(f64Bytes, this.len);
    this.len += 8;
    return this;
  }

  f64(val) {
    return this.writeF64(val);
  }

  writeString(str) {
    const utf8 = textEncoder.encode(String(str));
    this.writeU32(utf8.length);
    this.writeBytes(utf8);
    return this;
  }

  str(str) {
    return this.writeString(str);
  }

  toUint8Array() {
    return this.buf.slice(0, this.len);
  }

  toArray() {
    return Array.from(this.buf.subarray(0, this.len));
  }
}
