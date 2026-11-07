const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  isDesktopApp: true,
  setFullScreen: (flag) => ipcRenderer.invoke('window:set-fullscreen', flag),
  isFullScreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  openProjectDialog: () => ipcRenderer.invoke('dialog:open-project'),
  openMediaDialog: () => ipcRenderer.invoke('dialog:open-media'),
  onMenuCommand: (callback) => {
    ipcRenderer.on('menu:command', (_event, cmd) => callback(cmd));
  },
});
