/**
 * Lumen Type System & Unification Engine (`src/typechecker/types.js`)
 * Owned exclusively by Agent B.
 */

import {
  Types,
  unwrapType,
  typeToString,
  typesEqual,
  isGcManagedType,
  semanticTypeToLirType,
  mangleTypeName,
  resetTypeVarCounter,
} from "../contracts/index.js";

export {
  Types,
  unwrapType,
  typeToString,
  typesEqual,
  isGcManagedType,
  semanticTypeToLirType,
  mangleTypeName,
  resetTypeVarCounter,
};

/**
 * Type predicates for semantic types.
 */
export function isErrorType(t) {
  const ty = unwrapType(t);
  return !ty || ty.tag === "error";
}

export function isPrimitiveType(t, name = null) {
  const ty = unwrapType(t);
  if (!ty || ty.tag !== "prim") return false;
  return name ? ty.name === name : true;
}

export function isIntegerType(t) {
  const ty = unwrapType(t);
  return Boolean(ty && ty.tag === "prim" && (ty.name === "i32" || ty.name === "i64"));
}

export function isFloatType(t) {
  const ty = unwrapType(t);
  return Boolean(ty && ty.tag === "prim" && ty.name === "f64");
}

export function isNumericType(t) {
  const ty = unwrapType(t);
  return Boolean(
    ty && ty.tag === "prim" && (ty.name === "i32" || ty.name === "i64" || ty.name === "f64")
  );
}

export function isBoolType(t) {
  return isPrimitiveType(t, "bool");
}

export function isStringType(t) {
  return isPrimitiveType(t, "string");
}

export function isVoidType(t) {
  return isPrimitiveType(t, "void");
}

export function isOrderedType(t) {
  return isNumericType(t) || isStringType(t);
}

/**
 * Checks whether an unbound `typevar` with `typeVarId` occurs anywhere inside `type`.
 * Prevents infinite cyclic types during unification.
 */
export function occursIn(typeVarId, type, visited = new Set()) {
  const ty = unwrapType(type);
  if (!ty) return false;
  if (ty.tag === "typevar") {
    return ty.id === typeVarId;
  }
  if (visited.has(ty)) return false;
  visited.add(ty);

  switch (ty.tag) {
    case "array":
      return occursIn(typeVarId, ty.elem, visited);
    case "struct":
      if (ty.typeArgs && ty.typeArgs.some((arg) => occursIn(typeVarId, arg, visited))) {
        return true;
      }
      if (ty.fields && ty.fields.some((f) => occursIn(typeVarId, f.type, visited))) {
        return true;
      }
      return false;
    case "enum":
      if (ty.typeArgs && ty.typeArgs.some((arg) => occursIn(typeVarId, arg, visited))) {
        return true;
      }
      if (
        ty.variants &&
        ty.variants.some((v) => v.fields && v.fields.some((ft) => occursIn(typeVarId, ft, visited)))
      ) {
        return true;
      }
      return false;
    case "fn":
      if (ty.params && ty.params.some((p) => occursIn(typeVarId, p, visited))) {
        return true;
      }
      return occursIn(typeVarId, ty.ret, visited);
    default:
      return false;
  }
}

/**
 * Checks if `type` contains any unresolved `typevar`.
 */
export function containsUnboundTypeVar(type, visited = new Set()) {
  const ty = unwrapType(type);
  if (!ty) return false;
  if (ty.tag === "typevar") return true;
  if (visited.has(ty)) return false;
  visited.add(ty);

  switch (ty.tag) {
    case "array":
      return containsUnboundTypeVar(ty.elem, visited);
    case "struct":
    case "enum":
      return Boolean(
        ty.typeArgs && ty.typeArgs.some((arg) => containsUnboundTypeVar(arg, visited))
      );
    case "fn":
      return (
        Boolean(ty.params && ty.params.some((p) => containsUnboundTypeVar(p, visited))) ||
        containsUnboundTypeVar(ty.ret, visited)
      );
    default:
      return false;
  }
}

/**
 * Unifies two semantic types `t1` and `t2` in-place by binding `typevar.bound`.
 * Performs the occurs check to prevent cyclic types.
 * Returns `true` if unification succeeds, `false` otherwise.
 */
export function unify(t1, t2) {
  const a = unwrapType(t1);
  const b = unwrapType(t2);

  if (a === b) return true;
  if (!a || !b) return false;

  // Error poison type unifies with everything to suppress cascading errors
  if (a.tag === "error" || b.tag === "error") return true;

  if (a.tag === "typevar") {
    if (b.tag === "typevar" && a.id === b.id) return true;
    if (occursIn(a.id, b)) return false;
    a.bound = b;
    return true;
  }

  if (b.tag === "typevar") {
    if (occursIn(b.id, a)) return false;
    b.bound = a;
    return true;
  }

  if (a.tag !== b.tag) return false;

  switch (a.tag) {
    case "prim":
      return a.name === b.name;
    case "typeparam":
      return a.name === b.name;
    case "array":
      return unify(a.elem, b.elem);
    case "struct": {
      if (a.name !== b.name) return false;
      const aArgs = a.typeArgs || [];
      const bArgs = b.typeArgs || [];
      if (aArgs.length !== bArgs.length) return false;
      for (let i = 0; i < aArgs.length; i++) {
        if (!unify(aArgs[i], bArgs[i])) return false;
      }
      if (a.fields && b.fields && a.fields.length === b.fields.length) {
        for (let i = 0; i < a.fields.length; i++) {
          if (!unify(a.fields[i].type, b.fields[i].type)) return false;
        }
      }
      return true;
    }
    case "enum": {
      if (a.name !== b.name) return false;
      const aArgs = a.typeArgs || [];
      const bArgs = b.typeArgs || [];
      if (aArgs.length !== bArgs.length) return false;
      for (let i = 0; i < aArgs.length; i++) {
        if (!unify(aArgs[i], bArgs[i])) return false;
      }
      if (a.variants && b.variants && a.variants.length === b.variants.length) {
        for (let i = 0; i < a.variants.length; i++) {
          const vfA = a.variants[i].fields || [];
          const vfB = b.variants[i].fields || [];
          if (vfA.length !== vfB.length) return false;
          for (let j = 0; j < vfA.length; j++) {
            if (!unify(vfA[j], vfB[j])) return false;
          }
        }
      }
      return true;
    }
    case "fn": {
      const aParams = a.params || [];
      const bParams = b.params || [];
      if (aParams.length !== bParams.length) return false;
      for (let i = 0; i < aParams.length; i++) {
        if (!unify(aParams[i], bParams[i])) return false;
      }
      return unify(a.ret, b.ret);
    }
    default:
      return false;
  }
}

/**
 * Replaces `{ tag: "typeparam", name }` occurrences in `type` using `substMap`
 * (accepts either a `Map<string, Type>` or a plain object `{ [name]: Type }`).
 */
export function substituteTypeParams(type, substMap, visited = new Map()) {
  if (!substMap) return type;
  const lookup = (name) =>
    substMap instanceof Map
      ? substMap.get(name)
      : Object.prototype.hasOwnProperty.call(substMap, name)
        ? substMap[name]
        : undefined;

  const ty = unwrapType(type);
  if (!ty) return Types.VOID;

  switch (ty.tag) {
    case "prim":
    case "error":
    case "typevar":
      return ty;
    case "typeparam": {
      const mapped = lookup(ty.name);
      return mapped !== undefined ? mapped : ty;
    }
    case "array":
      return Types.array(substituteTypeParams(ty.elem, substMap, visited));
    case "struct": {
      if (visited.has(ty)) return visited.get(ty);
      const placeholder = Types.struct(ty.name, [], [], ty.defTypeParams || []);
      visited.set(ty, placeholder);
      placeholder.typeArgs = (ty.typeArgs || []).map((arg) =>
        substituteTypeParams(arg, substMap, visited)
      );
      placeholder.fields = (ty.fields || []).map((f) => ({
        ...f,
        type: substituteTypeParams(f.type, substMap, visited),
      }));
      return placeholder;
    }
    case "enum": {
      if (visited.has(ty)) return visited.get(ty);
      const placeholder = Types.enum(ty.name, [], [], ty.defTypeParams || []);
      visited.set(ty, placeholder);
      placeholder.typeArgs = (ty.typeArgs || []).map((arg) =>
        substituteTypeParams(arg, substMap, visited)
      );
      placeholder.variants = (ty.variants || []).map((v) => ({
        ...v,
        fields: (v.fields || []).map((ft) => substituteTypeParams(ft, substMap, visited)),
      }));
      return placeholder;
    }
    case "fn": {
      const params = (ty.params || []).map((p) => substituteTypeParams(p, substMap, visited));
      const ret = substituteTypeParams(ty.ret, substMap, visited);
      return Types.fn(params, ret, []);
    }
    default:
      return ty;
  }
}

/**
 * Recursively resolves all bound `typevar` nodes inside a type structure.
 */
export function deepResolveType(type, visited = new Map()) {
  const ty = unwrapType(type);
  if (!ty) return Types.VOID;

  switch (ty.tag) {
    case "prim":
    case "typeparam":
    case "error":
    case "typevar":
      return ty;
    case "array": {
      if (visited.has(ty)) return visited.get(ty);
      const res = Types.array(Types.VOID);
      visited.set(ty, res);
      res.elem = deepResolveType(ty.elem, visited);
      return res;
    }
    case "struct": {
      if (visited.has(ty)) return visited.get(ty);
      const res = Types.struct(ty.name, [], [], ty.defTypeParams || []);
      visited.set(ty, res);
      res.typeArgs = (ty.typeArgs || []).map((arg) => deepResolveType(arg, visited));
      res.fields = (ty.fields || []).map((f) => ({
        ...f,
        type: deepResolveType(f.type, visited),
      }));
      return res;
    }
    case "enum": {
      if (visited.has(ty)) return visited.get(ty);
      const res = Types.enum(ty.name, [], [], ty.defTypeParams || []);
      visited.set(ty, res);
      res.typeArgs = (ty.typeArgs || []).map((arg) => deepResolveType(arg, visited));
      res.variants = (ty.variants || []).map((v) => ({
        ...v,
        fields: (v.fields || []).map((ft) => deepResolveType(ft, visited)),
      }));
      return res;
    }
    case "fn": {
      if (visited.has(ty)) return visited.get(ty);
      const res = Types.fn([], Types.VOID, ty.typeParams || []);
      visited.set(ty, res);
      res.params = (ty.params || []).map((p) => deepResolveType(p, visited));
      res.ret = deepResolveType(ty.ret, visited);
      return res;
    }
    default:
      return ty;
  }
}

/**
 * Computes Levenshtein edit distance between two strings for "did you mean ...?" diagnostics.
 */
export function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Finds the closest candidate string within a reasonable edit distance.
 */
export function findClosestMatch(target, candidates, maxDistance = 2) {
  if (!target || !candidates) return null;
  let best = null;
  let bestDist = maxDistance + 1;
  for (const cand of candidates) {
    if (!cand || cand === target) continue;
    const dist = editDistance(target.toLowerCase(), cand.toLowerCase());
    if (dist < bestDist && dist <= Math.max(1, Math.min(maxDistance, Math.floor(cand.length / 2) + 1))) {
      bestDist = dist;
      best = cand;
    }
  }
  return best;
}
