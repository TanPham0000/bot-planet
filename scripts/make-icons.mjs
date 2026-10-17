// Renders assets/icon.html with Electron's offscreen renderer (no rsvg/ImageMagick needed),
// then builds the .icns with sips + iconutil.   Run: npm run icons  (= electron scripts/make-icons.mjs)
import { app, BrowserWindow } from 'electron';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const HTML = pathToFileURL(path.join(ASSETS, 'icon.html')).href;

app.dock?.hide();
app.on('window-all-closed', () => {}); // keep going between renders
app.disableHardwareAcceleration(); // software raster: exact pixels, no GPU readback quirks

function render(kind, size) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: size, height: size, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      useContentSize: true, enableLargerThanScreen: true,
      webPreferences: { offscreen: true },
    });
    win.webContents.setFrameRate(10);
    let done = false;
    const timeout = setTimeout(() => reject(new Error(`render ${kind}@${size} timed out`)), 15000);
    win.webContents.on('paint', (_e, _dirty, image) => {
      if (done || win.webContents.getTitle() !== 'ready') return;
      // Wait one more frame so filters/blur have definitely landed.
      setTimeout(async () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        let img = (await win.webContents.capturePage()) ?? image;
        if (img.isEmpty()) img = image;
        const s = img.getSize();
        if (s.width !== size) img = img.resize({ width: size, height: size, quality: 'best' });
        win.destroy();
        resolve(img.toPNG());
      }, 150);
    });
    win.loadURL(`${HTML}?kind=${kind}&size=${size}`);
  });
}

app.whenReady().then(async () => {
  try {
    const out = (name, buf) => { fs.writeFileSync(path.join(ASSETS, name), buf); console.log('wrote assets/' + name); };
    out('icon-1024.png', await render('app', 1024));
    out('trayTemplate.png', await render('tray', 18));
    out('trayTemplate@2x.png', await render('tray', 36));
    out('trayAlert.png', await render('alert', 18));
    out('trayAlert@2x.png', await render('alert', 36));

    const set = path.join(ASSETS, 'BotPlanet.iconset');
    fs.rmSync(set, { recursive: true, force: true });
    fs.mkdirSync(set);
    for (const s of [16, 32, 128, 256, 512]) {
      for (const [scale, px] of [['', s], ['@2x', s * 2]]) {
        const file = path.join(set, `icon_${s}x${s}${scale}.png`);
        if (px === 1024) fs.copyFileSync(path.join(ASSETS, 'icon-1024.png'), file);
        else execFileSync('sips', ['-z', String(px), String(px), path.join(ASSETS, 'icon-1024.png'), '--out', file], { stdio: 'ignore' });
      }
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(ASSETS, 'icon.icns')]);
    console.log('wrote assets/icon.icns');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  app.quit();
});
