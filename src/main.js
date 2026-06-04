const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Store = require('./store');
const ImapScanner = require('./imap-scanner');
const NotionSync = require('./notion-sync');

let mainWindow;
const store = new Store();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 780,
    minHeight: 560,
    backgroundColor: '#1a1a1a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../ui/index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// --- Settings ---
ipcMain.handle('get-settings', () => store.get());
ipcMain.handle('save-settings', (_, settings) => { store.set(settings); return true; });

// --- Manual scan ---
ipcMain.handle('scan-now', async () => {
  const settings = store.get();
  const hasMailbox1 = settings.imapUser && settings.imapPass;
  const hasMailbox2 = settings.imapUser2 && settings.imapPass2;
  if (!hasMailbox1 && !hasMailbox2) {
    return { error: 'Geen IMAP mailbox ingesteld. Vul de instellingen in.' };
  }
  if (!settings.notionToken || !settings.notionDbId) {
    return { error: 'Notion niet ingesteld. Vul de instellingen in.' };
  }
  if (!settings.anthropicKey) {
    return { error: 'Anthropic API key niet ingesteld.' };
  }

  try {
    // Scan beide mailboxen parallel
    const scanPromises = [];
    if (hasMailbox1) {
      scanPromises.push(new ImapScanner({ ...settings, imapUser: settings.imapUser, imapPass: settings.imapPass }).scan());
    }
    if (hasMailbox2) {
      scanPromises.push(new ImapScanner({ ...settings, imapUser: settings.imapUser2, imapPass: settings.imapPass2 }).scan());
    }
    const scanResults = await Promise.all(scanPromises);
    const allItems = scanResults.flat();

    // Dedupliceer over beide mailboxen
    const map = {};
    for (const item of allItems) {
      const key = item.ingredient.toLowerCase().trim();
      if (!map[key]) map[key] = { ...item, count: 1 };
      else { map[key].price = (map[key].price * map[key].count + item.price) / (map[key].count + 1); map[key].count++; }
    }
    const results = Object.values(map);

    if (results.length === 0) {
      return { alerts: [], message: 'Geen nieuwe facturen gevonden.' };
    }

    const notion = new NotionSync(settings);
    const notionPrices = await notion.getAllPrices();

    const alerts = [];
    const updates = [];

    for (const item of results) {
      const existing = notionPrices.find(n =>
        n.name.toLowerCase().trim() === item.ingredient.toLowerCase().trim()
      );

      if (existing) {
        const diff = ((item.price - existing.price) / existing.price) * 100;
        const threshold = settings.alertThreshold || 10;

        if (Math.abs(diff) >= threshold) {
          alerts.push({
            ingredient: item.ingredient,
            oldPrice: existing.price,
            newPrice: item.price,
            diff: diff.toFixed(1),
            eenheid: item.eenheid || existing.eenheid || 'kg',
            pageId: existing.pageId
          });
        }
        updates.push({ ...item, pageId: existing.pageId });
      } else {
        // Nieuw ingredient — voeg toe aan Notion
        updates.push({ ...item, isNew: true });
      }
    }

    // Notion updaten
    for (const u of updates) {
      await notion.updatePrice(u);
    }

    return {
      alerts,
      updated: updates.length,
      message: `${updates.length} prijzen bijgewerkt in Notion. ${alerts.length} alerts.`
    };
  } catch (err) {
    return { error: err.message };
  }
});

// --- Notion prijzen ophalen voor weergave ---
ipcMain.handle('get-notion-prices', async () => {
  const settings = store.get();
  if (!settings.notionToken || !settings.notionDbId) return [];
  try {
    const notion = new NotionSync(settings);
    return await notion.getAllPrices();
  } catch (e) {
    return [];
  }
});
