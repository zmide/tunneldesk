const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tunnelDeskDesktop", {
  setTheme(theme) {
    if (theme === "dark" || theme === "light") ipcRenderer.send("tunneldesk:set-theme", theme);
  }
});
