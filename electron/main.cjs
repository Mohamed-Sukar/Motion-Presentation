const { app, BrowserWindow, ipcMain, Menu, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { extractProjectPathFromArgv, isSupportedProjectFile } = require('./argvHelper.cjs');

let mainWindow = null;
let rendererReady = false;
let pendingProjectFilePath = null;
let currentMenuLanguage = null;

function resolveSystemLanguage() {
  try {
    const preferred =
      (typeof app.getPreferredSystemLanguages === 'function' &&
        app.getPreferredSystemLanguages()[0]) ||
      (typeof app.getLocale === 'function' && app.getLocale()) ||
      '';
    return String(preferred).trim().toLowerCase().startsWith('ar') ? 'ar' : 'en';
  } catch {
    return 'en';
  }
}

function getActiveLanguage() {
  return currentMenuLanguage || resolveSystemLanguage();
}

const MENU_TEXT = {
  ar: {
    file: 'ملف',
    openProject: 'فتح مشروع...',
    importMedia: 'استيراد وسائط...',
    newSlide: 'إضافة شريحة صورة...',
    loadDemo: 'توليد عرض تجريبي',
    saveProject: 'حفظ المشروع',
    saveAs: 'حفظ باسم...',
    quit: 'خروج',
    edit: 'تحرير',
    undo: 'تراجع',
    redo: 'إعادة',
    duplicateSlide: 'تكرار الشريحة المحددة',
    view: 'عرض',
    toggleNavigator: 'إظهار/إخفاء متصفح الشرائح',
    toggleInspector: 'إظهار/إخفاء لوحة الخصائص',
    playPresentation: 'تشغيل العرض بملء الشاشة',
    toggleFullscreen: 'ملء نافذة النظام',
    openProjectTitle: 'فتح ملف مشروع العرض الحركي',
    saveProjectTitle: 'حفظ ملف العرض التقديمي',
    importMediaTitle: 'استيراد وسائط العرض (صور وفيديوهات)',
    invalidSavePath: 'مسار الحفظ غير صالح.',
    projectFilterLabel: 'مشروع عرض حركي',
    mediaFilesFilter: 'ملفات الوسائط',
    imagesFilter: 'الصور',
    videosFilter: 'الفيديوهات',
    allFilesFilter: 'كافة الملفات',
  },
  en: {
    file: 'File',
    openProject: 'Open Project...',
    importMedia: 'Import Media...',
    newSlide: 'New Image Slide...',
    loadDemo: 'Load Demo Deck',
    saveProject: 'Save Project',
    saveAs: 'Save As...',
    quit: 'Quit',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    duplicateSlide: 'Duplicate Selected Slide',
    view: 'View',
    toggleNavigator: 'Toggle Slide Navigator',
    toggleInspector: 'Toggle Inspector Panel',
    playPresentation: 'Play Fullscreen Presentation',
    toggleFullscreen: 'Toggle Window Fullscreen',
    openProjectTitle: 'Open Motion Presentation Project',
    saveProjectTitle: 'Save Presentation Project',
    importMediaTitle: 'Import Presentation Media (Images & Videos)',
    invalidSavePath: 'Invalid save file path.',
    projectFilterLabel: 'Motion Presentation Project',
    mediaFilesFilter: 'Media Files',
    imagesFilter: 'Images',
    videosFilter: 'Videos',
    allFilesFilter: 'All Files',
  },
};

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function readProjectFilePayload(filePath) {
  const buf = await fs.promises.readFile(filePath);
  return {
    filePath,
    fileName: path.basename(filePath),
    buffer: toArrayBuffer(buf),
  };
}

async function enqueueOrSendProjectFile(filePath) {
  if (!filePath || !isSupportedProjectFile(filePath)) return;
  if (mainWindow && rendererReady && !mainWindow.isDestroyed()) {
    try {
      const payload = await readProjectFilePayload(filePath);
      mainWindow.webContents.send('project:open-file', payload);
      return;
    } catch (err) {
      console.error('Failed to read project file:', err);
    }
  }
  pendingProjectFilePath = filePath;
}

function buildNativeMenu(lang = getActiveLanguage()) {
  const L = MENU_TEXT[lang === 'en' ? 'en' : 'ar'];
  const sendCommand = (cmd) => {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('menu:command', cmd);
    }
  };

  const template = [
    {
      label: L.file,
      submenu: [
        {
          label: L.openProject,
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => sendCommand('open-project'),
        },
        {
          label: L.importMedia,
          accelerator: 'CmdOrCtrl+O',
          click: () => sendCommand('import-media'),
        },
        {
          label: L.newSlide,
          accelerator: 'CmdOrCtrl+N',
          click: () => sendCommand('add-slide'),
        },
        {
          label: L.loadDemo,
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => sendCommand('load-demo'),
        },
        { type: 'separator' },
        {
          label: L.saveProject,
          accelerator: 'CmdOrCtrl+S',
          click: () => sendCommand('save-project'),
        },
        {
          label: L.saveAs,
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendCommand('save-project-as'),
        },
        { type: 'separator' },
        { role: 'quit', label: L.quit },
      ],
    },
    {
      label: L.edit,
      submenu: [
        {
          label: L.undo,
          accelerator: 'CmdOrCtrl+Z',
          click: () => sendCommand('undo'),
        },
        {
          label: L.redo,
          accelerator: 'CmdOrCtrl+Y',
          click: () => sendCommand('redo'),
        },
        { type: 'separator' },
        {
          label: L.duplicateSlide,
          accelerator: 'CmdOrCtrl+D',
          click: () => sendCommand('duplicate-slide'),
        },
      ],
    },
    {
      label: L.view,
      submenu: [
        {
          label: L.toggleNavigator,
          accelerator: 'CmdOrCtrl+1',
          click: () => sendCommand('toggle-navigator'),
        },
        {
          label: L.toggleInspector,
          accelerator: 'CmdOrCtrl+I',
          click: () => sendCommand('toggle-inspector'),
        },
        { type: 'separator' },
        {
          label: L.playPresentation,
          accelerator: 'F5',
          click: () => sendCommand('start-presentation'),
        },
        { type: 'separator' },
        { role: 'togglefullscreen', label: L.toggleFullscreen },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  rendererReady = false;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#09090b' : '#f8f8fa',
    backgroundMaterial: 'mica',
    title: 'Motion Presentation Studio',
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.on('did-start-loading', () => {
    rendererReady = false;
  });

  buildNativeMenu();

  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5175';
  const distIndex = path.join(__dirname, '..', 'dist', 'index.html');

  if (fs.existsSync(distIndex) && !process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadFile(distIndex);
  } else {
    mainWindow.loadURL(devUrl);
  }
}

async function writeProjectToDisk(targetPath, payload) {
  const cleanBase = targetPath.replace(/(\.mpres\.json|\.json)$/i, '');
  const finalPath = cleanBase.toLowerCase().endsWith('.mpres') ? cleanBase : `${cleanBase}.mpres`;
  const data = Buffer.from(payload.bundleBytes);
  await fs.promises.writeFile(finalPath, data);
  return finalPath;
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  pendingProjectFilePath = extractProjectPathFromArgv(process.argv, {
    appPath: app.getAppPath(),
  });

  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const nextPath = extractProjectPathFromArgv(commandLine, {
      appPath: app.getAppPath(),
    });
    if (nextPath) {
      void enqueueOrSendProjectFile(nextPath);
    }
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (isSupportedProjectFile(filePath)) {
      void enqueueOrSendProjectFile(filePath);
    }
  });

  ipcMain.handle('window:set-fullscreen', (_event, flag) => {
    if (mainWindow) {
      mainWindow.setFullScreen(Boolean(flag));
      return mainWindow.isFullScreen();
    }
    return false;
  });

  ipcMain.handle('window:is-fullscreen', () => {
    return mainWindow ? mainWindow.isFullScreen() : false;
  });

  ipcMain.handle('window:set-title', (_event, title) => {
    if (mainWindow && !mainWindow.isDestroyed() && typeof title === 'string' && title.trim()) {
      mainWindow.setTitle(title.trim());
    }
  });

  ipcMain.handle('app:get-locale', () => {
    return resolveSystemLanguage();
  });

  ipcMain.handle('app:set-language', (_event, lang) => {
    const next = lang === 'en' ? 'en' : 'ar';
    currentMenuLanguage = next;
    buildNativeMenu(next);
    return next;
  });

  ipcMain.handle('app:set-theme', (_event, themePref) => {
    const source = themePref === 'light' || themePref === 'dark' ? themePref : 'system';
    nativeTheme.themeSource = source;
    const resolved = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(resolved === 'dark' ? '#09090b' : '#f8f8fa');
    }
    return resolved;
  });

  ipcMain.handle('project:consume-pending', async () => {
    rendererReady = true;
    const nextPath = pendingProjectFilePath;
    pendingProjectFilePath = null;
    if (!nextPath) return null;
    try {
      return await readProjectFilePayload(nextPath);
    } catch {
      return null;
    }
  });

  ipcMain.handle('dialog:open-project', async () => {
    if (!mainWindow) return null;
    const L = MENU_TEXT[getActiveLanguage()];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: L.openProjectTitle,
      properties: ['openFile'],
      filters: [
        { name: `${L.projectFilterLabel} (*.mpres, *.mpres.json)`, extensions: ['mpres', 'json'] },
        { name: L.allFilesFilter, extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return await readProjectFilePayload(result.filePaths[0]);
  });

  ipcMain.handle('dialog:save-project', async (_event, payload) => {
    if (!mainWindow || !payload) return null;
    const L = MENU_TEXT[getActiveLanguage()];
    let defaultTarget = payload.currentFilePath || payload.defaultFileName || 'presentation.mpres';
    if (/(\.mpres\.json|\.json)$/i.test(defaultTarget)) {
      defaultTarget = defaultTarget.replace(/(\.mpres\.json|\.json)$/i, '.mpres');
    } else if (!/\.mpres$/i.test(defaultTarget)) {
      defaultTarget = `${defaultTarget}.mpres`;
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: L.saveProjectTitle,
      defaultPath: defaultTarget,
      filters: [
        { name: `${L.projectFilterLabel} (*.mpres)`, extensions: ['mpres'] },
      ],
    });
    if (result.canceled || !result.filePath) return null;
    const savedPath = await writeProjectToDisk(result.filePath, payload);
    return {
      filePath: savedPath,
      fileName: path.basename(savedPath),
    };
  });

  ipcMain.handle('project:save-direct', async (_event, payload) => {
    const L = MENU_TEXT[getActiveLanguage()];
    if (!payload || typeof payload.filePath !== 'string' || !payload.filePath.trim()) {
      throw new Error(L.invalidSavePath);
    }
    const savedPath = await writeProjectToDisk(payload.filePath, payload);
    return {
      filePath: savedPath,
      fileName: path.basename(savedPath),
    };
  });

  ipcMain.handle('dialog:open-media', async () => {
    if (!mainWindow) return null;
    const L = MENU_TEXT[getActiveLanguage()];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: L.importMediaTitle,
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: L.mediaFilesFilter,
          extensions: [
            'png',
            'jpg',
            'jpeg',
            'webp',
            'avif',
            'svg',
            'bmp',
            'mp4',
            'webm',
            'mov',
            'm4v',
            'mkv',
            'ogv',
          ],
        },
        { name: L.imagesFilter, extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'svg', 'bmp'] },
        { name: L.videosFilter, extensions: ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'] },
        { name: L.allFilesFilter, extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const mimeMap = {
      mp4: 'video/mp4',
      m4v: 'video/mp4',
      webm: 'video/webm',
      mov: 'video/quicktime',
      mkv: 'video/x-matroska',
      ogv: 'video/ogg',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      avif: 'image/avif',
      svg: 'image/svg+xml',
      bmp: 'image/bmp',
    };

    const files = [];
    for (const filePath of result.filePaths) {
      const buf = await fs.promises.readFile(filePath);
      const fileName = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase().replace('.', '');
      const mimeType = mimeMap[ext] || 'application/octet-stream';
      files.push({
        fileName,
        mimeType,
        buffer: toArrayBuffer(buf),
      });
    }
    return files;
  });

  app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
