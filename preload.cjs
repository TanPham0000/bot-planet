// window.botPlanet: the bridge from docs/CONTRACT.md.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel, cb) => ipcRenderer.on(channel, (_e, value) => cb(value));

contextBridge.exposeInMainWorld('botPlanet', {
  setInteractive: (on) => ipcRenderer.send('set-interactive', !!on),
  setZone: (rect) => ipcRenderer.send('set-zone', rect && { x: +rect.x, y: +rect.y, w: +rect.w, h: +rect.h }),
  setHold: (on) => ipcRenderer.send('set-hold', !!on),
  setPinned: (on) => ipcRenderer.send('set-pinned', !!on),
  copy: (text) => ipcRenderer.send('copy', String(text ?? '')),
  focus: () => ipcRenderer.send('focus'),       // take keyboard focus (only while typing a name)
  savePostcard: (dataUrl) => ipcRenderer.invoke('save-postcard', String(dataUrl ?? '')), // → saved file path
  onExpanded: (cb) => listen('expanded', cb),
  onFocusAgent: (cb) => listen('focus-agent', cb),
  onPrefs: (cb) => listen('prefs', cb),
});
