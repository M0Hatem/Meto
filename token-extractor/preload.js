const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /**
   * Detect installed Discord clients.
   * @returns {Promise<Array<{ name: string, path: string }>>}
   */
  detectClients: () => ipcRenderer.invoke('detect-clients'),

  /**
   * Extract the user token from a Discord client's local storage.
   * @param {string} [clientFolder] - Optional: specific client folder to target
   * @returns {Promise<{ success: boolean, token?: string, client?: string, error?: string }>}
   */
  extractToken: (clientFolder) => ipcRenderer.invoke('extract-token', clientFolder),

  /**
   * Copy text to the system clipboard.
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),

  /**
   * Close the application.
   */
  closeApp: () => ipcRenderer.invoke('close-app')
});
