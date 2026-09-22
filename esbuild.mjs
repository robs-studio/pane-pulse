// Bundles src/extension.ts into ONE CommonJS file VS Code can require(), and copies
// hook/ next to it so the installer can copy the hook to <root>/ at install time.
//
// Why .cjs and not .js: package.json carries "type": "module" (src/*.ts must be ESM for
// verbatimModuleSyntax, and for Node's type stripping in tests/*.test.mjs), so a .js file
// here would be parsed as ESM. The extension entry point must be require()-able, so the
// bundle carries the explicit .cjs extension instead.
//
// A second build bundles src/webview/main.ts for the Panes panel's webview: a browser
// script, one IIFE with nothing external, loaded by the panel's HTML as dist/webview.js.
// When it ends, the files that webview loads beside it are copied into dist/ too:
// codicon.css and codicon.ttf from @vscode/codicons into dist/codicons/ (`vsce package
// --no-dependencies` never ships node_modules, so they must live in dist/), and
// media/panel.css as dist/panel.css. Watch mode rebuilds on a change to panel.css as well,
// since the webview build names it as a file to watch.
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(root, 'dist');
const hookSrc = path.join(root, 'hook');
const hookOut = path.join(outDir, 'hook');
const webviewEntry = path.join(root, 'src', 'webview', 'main.ts');
const panelCss = path.join(root, 'media', 'panel.css');
const codiconsSrc = path.join(root, 'node_modules', '@vscode', 'codicons', 'dist');
const codiconsOut = path.join(outDir, 'codicons');
const CODICON_FILES = ['codicon.css', 'codicon.ttf'];
const watch = process.argv.includes('--watch');

async function copyHook() {
  if (!existsSync(hookSrc)) return;
  await rm(hookOut, { recursive: true, force: true });
  await cp(hookSrc, hookOut, { recursive: true });
}

const copyHookPlugin = {
  name: 'copy-hook',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      await copyHook();
    });
  },
};

/** Copies the codicon font and its stylesheet, and the panel's stylesheet, into dist/. */
async function copyWebviewAssets() {
  await mkdir(codiconsOut, { recursive: true });
  for (const name of CODICON_FILES) {
    await copyFile(path.join(codiconsSrc, name), path.join(codiconsOut, name));
  }
  await copyFile(panelCss, path.join(outDir, 'panel.css'));
}

const webviewAssetsPlugin = {
  name: 'webview-assets',
  setup(build) {
    // main.ts loads exactly as esbuild would load it; the only addition is panel.css as a
    // file to watch, so an edit to the stylesheet alone rebuilds and re-copies it.
    build.onLoad({ filter: /[\\/]src[\\/]webview[\\/]main\.ts$/ }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'ts',
      watchFiles: [panelCss],
    }));
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return undefined;
      try {
        await copyWebviewAssets();
        return undefined;
      } catch (error) {
        // A missing codicons package (npm install not run) or a missing panel.css fails the
        // build by name rather than leaving a webview with no icons or no styles.
        return { errors: [{ text: `copying the webview's files into dist/ failed: ${error.message}` }] };
      }
    });
  },
};

const options = {
  entryPoints: [path.join(root, 'src', 'extension.ts')],
  outfile: path.join(outDir, 'extension.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
  // jsonc-parser's `main` is a UMD wrapper whose inner require() is a parameter, which esbuild
  // cannot follow: bundled that way, it throws "Cannot find module './impl/format'" at load.
  // Its `module` field is a plain ESM build that bundles whole, so ESM is preferred.
  mainFields: ['module', 'main'],
  sourcemap: true,
  logLevel: 'info',
  plugins: [copyHookPlugin],
};

const webviewOptions = {
  entryPoints: [webviewEntry],
  outfile: path.join(outDir, 'webview.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
  plugins: [webviewAssetsPlugin],
};

await mkdir(outDir, { recursive: true });

if (watch) {
  const contexts = await Promise.all([esbuild.context(options), esbuild.context(webviewOptions)]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('[pane-pulse] watching src/, hook/ and media/panel.css');
} else {
  // Both builds always run to the end, so one failing never cuts the other off half-written;
  // each failure is printed (esbuild logs a compile error itself, but not one an onEnd
  // callback returns) and the exit code says the build failed.
  const results = await Promise.allSettled([esbuild.build(options), esbuild.build(webviewOptions)]);
  const failures = results.filter((result) => result.status === 'rejected');
  for (const failure of failures) console.error(failure.reason?.message ?? String(failure.reason));
  if (failures.length > 0) process.exitCode = 1;
}
