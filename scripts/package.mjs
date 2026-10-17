// Builds dist/Bot Planet-darwin-arm64/Bot Planet.app, ad-hoc signs it.
//   npm run package               → build + sign
//   npm run package -- --install  → …and copy it to /Applications (replacing an old copy)
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'Bot Planet';
const install = process.argv.includes('--install');

if (!fs.existsSync(path.join(ROOT, 'assets', 'icon.icns'))) {
  console.error('assets/icon.icns missing — run `npm run icons` first.');
  process.exit(1);
}

const [outDir] = await packager({
  dir: ROOT,
  out: path.join(ROOT, 'dist'),
  name: NAME,
  executableName: NAME,
  platform: 'darwin',
  arch: 'arm64',
  appBundleId: 'nl.phamcreative.botplanet',
  appCategoryType: 'public.app-category.developer-tools',
  icon: path.join(ROOT, 'assets', 'icon.icns'),
  overwrite: true,
  prune: true,
  asar: false, // server.mjs serves index.html / three / assets straight from disk
  extendInfo: { LSUIElement: true },
  ignore: [/^\/dist(\/|$)/, /^\/docs(\/|$)/, /\.iconset(\/|$)/, /^\/README\.md$/, /^\/\.claude(\/|$)/],
});

const appPath = path.join(outDir, `${NAME}.app`);
execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
console.log(`Built and ad-hoc signed: ${path.relative(ROOT, appPath)}`);

if (install) {
  const dest = path.join('/Applications', `${NAME}.app`);
  try { execFileSync('pkill', ['-f', `${dest}/Contents/MacOS/`]); } catch {}
  fs.rmSync(dest, { recursive: true, force: true });
  execFileSync('ditto', [appPath, dest], { stdio: 'inherit' });
  console.log(`Installed to ${dest}`);
}
