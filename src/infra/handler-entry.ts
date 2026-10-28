/**
 * Resolve Lambda handler source (`.ts`) entry paths that exist under both
 * runtimes this code runs in.
 *
 * The CDK app is executed in two different ways:
 *
 *  - **Tests** run the TypeScript sources directly (through Vitest/tsx), so a
 *    module's `__dirname` is the real source directory, e.g. `…/src/infra`.
 *  - **`cdk synth`** runs the compiled build: `cdk.json` invokes
 *    `tsc -p tsconfig.build.json && node dist/bin/app.js`, so the compiled
 *    modules live under `dist/src/infra` and their `__dirname` points there.
 *
 * A `NodejsFunction` `entry` must point at the handler's TypeScript *source*
 * (esbuild bundles from `.ts`); only `.js` is emitted into `dist`, so computing
 * the entry from the compiled `__dirname` resolves to a non-existent
 * `dist/src/infra/handlers/<handler>.ts` and synth fails with
 * `Cannot find entry file …`.
 *
 * {@link handlersSourceDir} maps a compiled `__dirname` back to the matching
 * source directory by dropping the `dist` path segment the build emits into
 * (`tsconfig.build.json` compiles `src/` to `dist/src/`, so `dist/src/infra`
 * collapses to `src/infra`); under the test runtime `__dirname` is already a
 * source path and is returned unchanged. {@link handlerEntry} then joins the
 * `handlers/<handler>.ts` source file onto it.
 *
 * Both functions are pure path computations and perform no I/O.
 */

import * as path from 'node:path';

/**
 * Map a module's `__dirname` to the corresponding source directory.
 *
 * When `dirname` contains a `/dist/` segment (the compiled `cdk synth`
 * runtime), that single `dist` segment is removed so the remaining path points
 * at the TypeScript sources. The build compiles `src/` to `dist/src/`, so
 * `…/dist/src/infra` collapses to `…/src/infra`. Otherwise `dirname` is already
 * a source directory (the test runtime) and is returned unchanged.
 *
 * @param dirname - The calling module's `__dirname`.
 * @returns The equivalent source-tree directory.
 */
export function handlersSourceDir(dirname: string): string {
  const marker = `${path.sep}dist${path.sep}`;
  const index = dirname.indexOf(marker);
  if (index === -1) {
    return dirname;
  }
  // Drop the `dist` segment, joining the parent of `dist` directly to whatever
  // followed it (`…/dist/src/infra` → `…/src/infra`).
  return dirname.slice(0, index) + path.sep + dirname.slice(index + marker.length);
}

/**
 * Resolve the `.ts` source entry for a named handler, relative to the calling
 * module's `__dirname`, so the path exists under both the test and `cdk synth`
 * runtimes.
 *
 * @param dirname - The `__dirname` of the `src/infra` module computing the entry.
 * @param handlerFile - The handler source file name, e.g. `bootstrap-broker.ts`.
 * @returns An absolute path to `<sourceDir>/handlers/<handlerFile>`.
 */
export function handlerEntry(dirname: string, handlerFile: string): string {
  return path.join(handlersSourceDir(dirname), 'handlers', handlerFile);
}
