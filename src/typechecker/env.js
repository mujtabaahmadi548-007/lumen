/**
 * Lumen Type Environment & Lexical Scope Manager (`src/typechecker/env.js`)
 * Owned exclusively by Agent B.
 */

import { Types, substituteTypeParams } from "./types.js";

/**
 * Represents a lexical scope for variables, parameters, and type parameters.
 * Tracks function nesting depth (`fnDepth`) and loop depth (`loopDepth`)
 * so closure free-variable captures and mutable variable boxing are computed accurately.
 */
export class Scope {
  constructor(parent = null, options = {}) {
    this.parent = parent;
    this.bindings = new Map();
    this.typeParams = new Map(parent ? parent.typeParams : []);
    this.fnDepth =
      options.fnDepth !== undefined ? options.fnDepth : parent ? parent.fnDepth : 0;
    this.loopDepth =
      options.loopDepth !== undefined ? options.loopDepth : parent ? parent.loopDepth : 0;
    this.returnType =
      options.returnType !== undefined
        ? options.returnType
        : parent
          ? parent.returnType
          : null;
    this.isClosureBoundary = Boolean(options.isClosureBoundary);
    this.captures = options.isClosureBoundary
      ? new Map()
      : parent
        ? parent.captures
        : null;
  }

  /**
   * Create a nested block scope inside the same function/closure.
   */
  child(options = {}) {
    return new Scope(this, options);
  }

  /**
   * Create a nested loop scope (increments `loopDepth`).
   */
  childLoop() {
    return new Scope(this, { loopDepth: this.loopDepth + 1 });
  }

  /**
   * Create a new top-level function scope (`fnDepth = 1`, `loopDepth = 0`).
   */
  childFunction(returnType, typeParamNames = []) {
    const scope = new Scope(this, {
      fnDepth: 1,
      loopDepth: 0,
      returnType,
      isClosureBoundary: false,
    });
    for (const tp of typeParamNames) {
      scope.defineTypeParam(tp);
    }
    return scope;
  }

  /**
   * Create a nested closure scope (`fnDepth = parent.fnDepth + 1`, `loopDepth = 0`, fresh `captures` map).
   */
  childClosure(returnType) {
    return new Scope(this, {
      fnDepth: this.fnDepth + 1,
      loopDepth: 0,
      returnType,
      isClosureBoundary: true,
    });
  }

  /**
   * Register a generic type parameter (`T`, `U`, etc.) in this scope.
   */
  defineTypeParam(name, type = Types.typeparam(name)) {
    this.typeParams.set(name, type);
    return type;
  }

  /**
   * Look up a generic type parameter in this scope or parent scopes.
   */
  lookupTypeParam(name) {
    return this.typeParams.get(name) || null;
  }

  /**
   * Define a variable or parameter binding in the current lexical scope.
   */
  define(name, type, options = {}) {
    const binding = {
      name,
      type,
      mutable: Boolean(options.mutable),
      isParam: Boolean(options.isParam),
      isConst: Boolean(options.isConst),
      isCaptured: false,
      isBoxed: false,
      definedAtScope: this,
      fnDepth: this.fnDepth,
      declNode: options.declNode || null,
      span: options.span || null,
    };
    this.bindings.set(name, binding);
    return binding;
  }

  /**
   * Check if `name` is defined directly in the immediate scope (not ancestors).
   */
  hasOwn(name) {
    return this.bindings.has(name);
  }

  /**
   * Look up a variable by name across the scope chain.
   * If a local variable from an enclosing function/closure (`1 <= binding.fnDepth < this.fnDepth`)
   * is referenced inside a nested closure, automatically records the capture across all crossed
   * closure boundaries and marks mutable captured bindings with `isBoxed = true`.
   */
  lookup(name, recordCapture = true) {
    let cur = this;
    while (cur) {
      if (cur.bindings.has(name)) {
        const binding = cur.bindings.get(name);
        if (
          recordCapture &&
          binding.fnDepth >= 1 &&
          binding.fnDepth < this.fnDepth
        ) {
          binding.isCaptured = true;
          if (binding.mutable) {
            binding.isBoxed = true;
          }
          if (binding.declNode) {
            binding.declNode.isCaptured = true;
            if (binding.mutable) {
              binding.declNode.isBoxed = true;
            }
          }
          // Record capture on every intermediate closure boundary between `this` and `cur`
          let walker = this;
          while (walker && walker !== cur && walker.fnDepth > binding.fnDepth) {
            if (walker.isClosureBoundary && walker.captures) {
              walker.captures.set(name, {
                name: binding.name,
                type: binding.type,
                mutable: binding.mutable,
                isBoxed: binding.isBoxed,
                outerBinding: binding,
              });
            }
            walker = walker.parent;
          }
        }
        return binding;
      }
      cur = cur.parent;
    }
    return null;
  }

  /**
   * Collect all variable names visible from this scope for diagnostic suggestions.
   */
  collectVisibleNames() {
    const names = new Set();
    let cur = this;
    while (cur) {
      for (const k of cur.bindings.keys()) {
        names.add(k);
      }
      cur = cur.parent;
    }
    return Array.from(names);
  }
}

/**
 * Global Type Environment for a Lumen module / program.
 * Holds registered Structs, Enums, Variant Constructors, Built-in & User Functions, and Constants.
 */
export class TypeEnv {
  constructor() {
    this.structs = new Map();
    this.enums = new Map();
    this.variants = new Map();
    this.functions = new Map();
    this.constants = new Map();
    this.globalScope = new Scope(null, { fnDepth: 0, loopDepth: 0 });

    this._initPreludeTypes();
    this._initBuiltinFunctions();
  }

  /**
   * Register built-in prelude algebraic data types: `Option<T>` and `Result<T, E>`.
   */
  _initPreludeTypes() {
    const T = Types.typeparam("T");
    const E = Types.typeparam("E");

    this.registerEnum({
      name: "Option",
      typeParams: ["T"],
      variants: [
        { name: "Some", fields: [T], tagIndex: 0 },
        { name: "None", fields: [], tagIndex: 1 },
      ],
      isPublic: true,
      isBuiltin: true,
      span: null,
    });

    this.registerEnum({
      name: "Result",
      typeParams: ["T", "E"],
      variants: [
        { name: "Ok", fields: [T], tagIndex: 0 },
        { name: "Err", fields: [E], tagIndex: 1 },
      ],
      isPublic: true,
      isBuiltin: true,
      span: null,
    });
  }

  /**
   * Register all built-in functions matching `BUILTIN_NAMES` in `src/contracts/index.js`.
   */
  _initBuiltinFunctions() {
    const T = Types.typeparam("T");

    // Polymorphic I/O built-ins
    this._registerBuiltin("print", ["T"], [T], Types.VOID, {
      isPolymorphicPrint: true,
      minArgs: 1,
      maxArgs: 16,
    });
    this._registerBuiltin("println", ["T"], [T], Types.VOID, {
      isPolymorphicPrint: true,
      minArgs: 0,
      maxArgs: 16,
    });

    // Primitive formatting conversions
    this._registerBuiltin("int_to_string", [], [Types.I32], Types.STRING);
    this._registerBuiltin("i64_to_string", [], [Types.I64], Types.STRING);
    this._registerBuiltin("float_to_string", [], [Types.F64], Types.STRING);
    this._registerBuiltin("bool_to_string", [], [Types.BOOL], Types.STRING);

    // Numeric conversions
    this._registerBuiltin("int_to_float", [], [Types.I32], Types.F64);
    this._registerBuiltin("float_to_int", [], [Types.F64], Types.I32);
    this._registerBuiltin("i32_to_i64", [], [Types.I32], Types.I64);
    this._registerBuiltin("i64_to_i32", [], [Types.I64], Types.I32);

    // String built-ins
    this._registerBuiltin("str_len", [], [Types.STRING], Types.I32);
    this._registerBuiltin("str_concat", [], [Types.STRING, Types.STRING], Types.STRING);
    this._registerBuiltin(
      "str_slice",
      [],
      [Types.STRING, Types.I32, Types.I32],
      Types.STRING
    );
    this._registerBuiltin("str_char_at", [], [Types.STRING, Types.I32], Types.I32);
    this._registerBuiltin("str_from_char_code", [], [Types.I32], Types.STRING);
    this._registerBuiltin("str_eq", [], [Types.STRING, Types.STRING], Types.BOOL);
    this._registerBuiltin("str_hash", [], [Types.STRING], Types.I32);
    this._registerBuiltin("str_to_int", [], [Types.STRING], Types.I32);

    // Generic dynamic array built-ins
    this._registerBuiltin("array_len", ["T"], [Types.array(T)], Types.I32);
    this._registerBuiltin("array_push", ["T"], [Types.array(T), T], Types.VOID);
    this._registerBuiltin("array_pop", ["T"], [Types.array(T)], T);
    this._registerBuiltin("array_new", ["T"], [], Types.array(T));

    // Generic equality & hashing intrinsics
    this._registerBuiltin("eq", ["T"], [T, T], Types.BOOL);
    this._registerBuiltin("hash", ["T"], [T], Types.I32);

    // Math built-ins
    this._registerBuiltin("sqrt", [], [Types.F64], Types.F64);
    this._registerBuiltin("sin", [], [Types.F64], Types.F64);
    this._registerBuiltin("cos", [], [Types.F64], Types.F64);
    this._registerBuiltin("abs_f64", [], [Types.F64], Types.F64);
    this._registerBuiltin("abs_i32", [], [Types.I32], Types.I32);
    this._registerBuiltin("floor", [], [Types.F64], Types.F64);
    this._registerBuiltin("ceil", [], [Types.F64], Types.F64);
    this._registerBuiltin("pow", [], [Types.F64, Types.F64], Types.F64);

    // Garbage collector & runtime telemetry built-ins
    this._registerBuiltin("gc_collect", [], [], Types.VOID);
    this._registerBuiltin("gc_live_bytes", [], [], Types.I32);
    this._registerBuiltin("gc_total_allocated", [], [], Types.I32);
    this._registerBuiltin("gc_collection_count", [], [], Types.I32);
    this._registerBuiltin("clock_ms", [], [], Types.F64);

    // Assertions & panics
    this._registerBuiltin("assert", [], [Types.BOOL, Types.STRING], Types.VOID, {
      isVariadicAssert: true,
      minArgs: 1,
      maxArgs: 2,
    });
    this._registerBuiltin("panic", ["T"], [Types.STRING], T, {
      isDiverging: true,
      minArgs: 1,
      maxArgs: 1,
    });
  }

  _registerBuiltin(name, typeParams, paramTypes, returnType, extra = {}) {
    const fnType = Types.fn(paramTypes, returnType, typeParams);
    const def = {
      name,
      typeParams,
      paramTypes,
      returnType,
      fnType,
      isBuiltin: true,
      isPublic: true,
      minArgs: extra.minArgs !== undefined ? extra.minArgs : paramTypes.length,
      maxArgs: extra.maxArgs !== undefined ? extra.maxArgs : paramTypes.length,
      isPolymorphicPrint: Boolean(extra.isPolymorphicPrint),
      isVariadicAssert: Boolean(extra.isVariadicAssert),
      isDiverging: Boolean(extra.isDiverging),
      decl: null,
      span: null,
    };
    this.functions.set(name, def);
  }

  /**
   * Register a struct definition.
   */
  registerStruct(def) {
    const entry = {
      name: def.name,
      typeParams: def.typeParams || [],
      fields: def.fields || [],
      isPublic: def.isPublic !== undefined ? def.isPublic : true,
      isBuiltin: Boolean(def.isBuiltin),
      decl: def.decl || null,
      span: def.span || null,
    };
    this.structs.set(def.name, entry);
    return entry;
  }

  getStruct(name) {
    return this.structs.get(name) || null;
  }

  hasStruct(name) {
    return this.structs.has(name);
  }

  /**
   * Instantiate a registered struct with concrete `typeArgs` (or fresh `typevar`s if null).
   */
  instantiateStruct(name, typeArgs = null) {
    const def = this.structs.get(name);
    if (!def) return null;

    const resolvedArgs =
      typeArgs && typeArgs.length === def.typeParams.length
        ? typeArgs
        : def.typeParams.map((tp) => Types.typevar(tp));

    const subst = new Map();
    for (let i = 0; i < def.typeParams.length; i++) {
      subst.set(def.typeParams[i], resolvedArgs[i]);
    }

    const instFields = def.fields.map((f) => ({
      name: f.name,
      type: substituteTypeParams(f.type, subst),
    }));

    return Types.struct(def.name, resolvedArgs, instFields, def.typeParams);
  }

  /**
   * Register an enum definition and index its variants for both qualified and unqualified lookup.
   */
  registerEnum(def) {
    const variants = (def.variants || []).map((v, idx) => ({
      name: v.name,
      fields: v.fields || [],
      tagIndex: v.tagIndex !== undefined ? v.tagIndex : idx,
      span: v.span || null,
    }));

    const entry = {
      name: def.name,
      typeParams: def.typeParams || [],
      variants,
      isPublic: def.isPublic !== undefined ? def.isPublic : true,
      isBuiltin: Boolean(def.isBuiltin),
      decl: def.decl || null,
      span: def.span || null,
    };

    this.enums.set(def.name, entry);

    for (const v of variants) {
      this.variants.set(v.name, {
        enumName: def.name,
        variantName: v.name,
        tagIndex: v.tagIndex,
        payloadTypes: v.fields,
        typeParams: def.typeParams || [],
      });
    }

    return entry;
  }

  getEnum(name) {
    return this.enums.get(name) || null;
  }

  hasEnum(name) {
    return this.enums.has(name);
  }

  /**
   * Instantiate a registered enum with concrete `typeArgs` (or fresh `typevar`s if null).
   */
  instantiateEnum(name, typeArgs = null) {
    const def = this.enums.get(name);
    if (!def) return null;

    const resolvedArgs =
      typeArgs && typeArgs.length === def.typeParams.length
        ? typeArgs
        : def.typeParams.map((tp) => Types.typevar(tp));

    const subst = new Map();
    for (let i = 0; i < def.typeParams.length; i++) {
      subst.set(def.typeParams[i], resolvedArgs[i]);
    }

    const instVariants = def.variants.map((v) => ({
      name: v.name,
      tagIndex: v.tagIndex,
      fields: v.fields.map((ft) => substituteTypeParams(ft, subst)),
    }));

    return Types.enum(def.name, resolvedArgs, instVariants, def.typeParams);
  }

  /**
   * Look up an enum variant either qualified (`enumName, variantName`) or unqualified (`null, variantName`).
   */
  lookupVariant(enumName, variantName) {
    if (variantName === undefined) {
      variantName = enumName;
      enumName = null;
    }
    if (enumName) {
      const enumDef = this.enums.get(enumName);
      if (!enumDef) return null;
      const v = enumDef.variants.find((item) => item.name === variantName);
      if (!v) return null;
      return {
        enumDef,
        enumName: enumDef.name,
        variantName: v.name,
        tagIndex: v.tagIndex,
        payloadTypes: v.fields,
        typeParams: enumDef.typeParams,
      };
    }

    const vInfo = this.variants.get(variantName);
    if (!vInfo) return null;
    const enumDef = this.enums.get(vInfo.enumName);
    return {
      ...vInfo,
      enumDef,
    };
  }

  /**
   * Register a user-defined function signature.
   */
  registerFunction(def) {
    const paramTypes = def.paramTypes || [];
    const returnType = def.returnType || Types.VOID;
    const typeParams = def.typeParams || [];
    const fnType = Types.fn(paramTypes, returnType, typeParams);
    const entry = {
      name: def.name,
      typeParams,
      paramTypes,
      returnType,
      fnType,
      isBuiltin: Boolean(def.isBuiltin),
      isPublic: def.isPublic !== undefined ? def.isPublic : true,
      minArgs: def.minArgs !== undefined ? def.minArgs : paramTypes.length,
      maxArgs: def.maxArgs !== undefined ? def.maxArgs : paramTypes.length,
      decl: def.decl || null,
      span: def.span || null,
    };
    this.functions.set(def.name, entry);
    return entry;
  }

  getFunction(name) {
    return this.functions.get(name) || null;
  }

  hasFunction(name) {
    return this.functions.has(name);
  }

  /**
   * Register a top-level constant declaration.
   */
  registerConstant(def) {
    const entry = {
      name: def.name,
      type: def.type,
      isPublic: def.isPublic !== undefined ? def.isPublic : true,
      decl: def.decl || null,
      span: def.span || null,
    };
    this.constants.set(def.name, entry);
    this.globalScope.define(def.name, def.type, {
      mutable: false,
      isConst: true,
      declNode: def.decl || null,
      span: def.span || null,
    });
    return entry;
  }

  getConstant(name) {
    return this.constants.get(name) || null;
  }

  /**
   * Return all known type names (primitives + structs + enums) for diagnostics.
   */
  getAllTypeNames() {
    return [
      "i32",
      "i64",
      "f64",
      "bool",
      "string",
      "void",
      ...this.structs.keys(),
      ...this.enums.keys(),
    ];
  }

  /**
   * Return all known global function/constant/variant names for diagnostics.
   */
  getAllValueNames(scope = null) {
    const set = new Set([
      ...this.functions.keys(),
      ...this.constants.keys(),
      ...this.variants.keys(),
    ]);
    if (scope) {
      for (const name of scope.collectVisibleNames()) {
        set.add(name);
      }
    }
    return Array.from(set);
  }
}
