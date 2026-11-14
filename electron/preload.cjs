const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  isDesktopApp: true,
  setFullScreen: (flag) => ipcRenderer.invoke('window:set-fullscreen', flag),
  isFullScreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  setWindowTitle: (title) => ipcRenderer.invoke('window:set-title', title),
  getSystemLocale: () => ipcRenderer.invoke('app:get-locale'),
  setLanguage: (lang) => ipcRenderer.invoke('app:set-language', lang),
  setTheme: (themePref) => ipcRenderer.invoke('app:set-theme', themePref),
  openProjectDialog: () => ipcRenderer.invoke('dialog:open-project'),
  saveProjectDialog: (payload) => ipcRenderer.invoke('dialog:save-project', payload),
  saveProjectDirect: (payload) => ipcRenderer.invoke('project:save-direct', payload),
  consumePendingProjectFile: () => ipcRenderer.invoke('project:consume-pending'),
  onOpenProjectFile: (callback) => {
    ipcRenderer.on('project:open-file', (_event, payload) => callback(payload));
  },
  openMediaDialog: () => ipcRenderer.invoke('dialog:open-media'),
  onMenuCommand: (callback) => {
    ipcRenderer.on('menu:command', (_event, cmd) => callback(cmd));
  },
  getPathForFile: (file) => {
    try {
      return webUtils?.getPathForFile ? webUtils.getPathForFile(file) : null;
    } catch {
      return null;
    }
  },
});
