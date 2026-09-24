/**
 * Resolve hook: this project imports its own modules without extensions the way
 * Vite likes it (`./edt`, not `./edt.ts`).  Node's ESM resolver needs the real
 * file, so retry extensionless relative specifiers with `.ts` appended.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    try {
      return await nextResolve(specifier, context);
    } catch {
      return await nextResolve(`${specifier}.ts`, context);
    }
  }
  return nextResolve(specifier, context);
}
