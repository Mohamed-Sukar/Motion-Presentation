const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;

function buildNativeMenu() {
  const sendCommand = (cmd) => {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('menu:command', cmd);
    }
  };

  const template = [
    {
      label: 'ملف (File)',
      submenu: [
        {
          label: 'فتح مشروع (Open Project)...',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => sendCommand('open-project'),
        },
        {
          label: 'استيراد وسائط (Import Media)...',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendCommand('import-media'),
        },
        {
          label: 'إضافة شريحة صورة (New Slide)...',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendCommand('add-slide'),
        },
        {
          label: 'توليد عرض تجريبي (Load Demo)',
          accelerator: 'CmdOrCtrl+D',
          click: () => sendCommand('load-demo'),
        },
        { type: 'separator' },
        {
          label: 'حفظ ملف المشروع (Save Project)...',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendCommand('save-project'),
        },
        { type: 'separator' },
        { role: 'quit', label: 'خروج (Quit)' },
      ],
    },
    {
      label: 'عرض (View)',
      submenu: [
        {
          label: 'إظهار/إخفاء متصفح الشرائح (Toggle Navigator)',
          accelerator: 'CmdOrCtrl+1',
          click: () => sendCommand('toggle-navigator'),
        },
        {
          label: 'إظهار/إخفاء لوحة الخصائص (Toggle Inspector)',
          accelerator: 'CmdOrCtrl+I',
          click: () => sendCommand('toggle-inspector'),
        },
        { type: 'separator' },
        {
          label: 'تشغيل العرض بملء الشاشة (Play Presentation)',
          accelerator: 'F5',
          click: () => sendCommand('start-presentation'),
        },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'ملء نافذة النظام' },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#161618',
    backgroundMaterial: 'mica',
    title: 'Motion Presentation',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
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

ipcMain.handle('dialog:open-project', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'فتح ملف مشروع العرض الحركي',
    properties: ['openFile'],
    filters: [
      { name: 'Motion Presentation Project (*.mpres.json, *.json)', extensions: ['json', 'mpres.json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const content = await fs.promises.readFile(filePath, 'utf-8');
  return { filePath, content, fileName: path.basename(filePath) };
});

ipcMain.handle('dialog:open-media', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'استيراد وسائط العرض (صور وفيديوهات)',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Media Files', extensions: ['png', 'jpg', 'jpeg', 'webp', 'mp4', 'webm'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
      { name: 'Videos', extensions: ['mp4', 'webm'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const files = [];
  for (const filePath of result.filePaths) {
    const buf = await fs.promises.readFile(filePath);
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mimeType = ['mp4', 'webm'].includes(ext)
      ? `video/${ext}`
      : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
    files.push({
      fileName,
      mimeType,
      buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
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
