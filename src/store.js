const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class Store {
  constructor() {
    const userDataPath = app.getPath('userData');
    this.filePath = path.join(userDataPath, 'settings.json');
  }

  get() {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch (e) {}
    return {};
  }

  set(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }
}

module.exports = Store;
