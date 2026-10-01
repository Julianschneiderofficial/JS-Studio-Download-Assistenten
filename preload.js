const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  getInitialState: () => ipcRenderer.invoke('launcher:get-initial-state'),
  openReleaseConfig: () => ipcRenderer.invoke('launcher:open-release-config'),
  refreshProductCatalog: () => ipcRenderer.invoke('products:refresh-catalog'),
  checkAssistantUpdate: () => ipcRenderer.invoke('assistant:check-update'),
  downloadAssistantUpdate: () => ipcRenderer.invoke('assistant:download-update'),
  installAssistantUpdate: () => ipcRenderer.invoke('assistant:install-update'),
  installProduct: (productId) => ipcRenderer.invoke('products:install', productId),
  uninstallProduct: (productId) => ipcRenderer.invoke('products:uninstall', productId),
  uninstallAssistant: () => ipcRenderer.invoke('assistant:uninstall'),
  onProductStatus: (listener) => {
    const handler = (_event, status) => listener(status);
    ipcRenderer.on('products:status', handler);
    return () => ipcRenderer.removeListener('products:status', handler);
  },
  onInstallProgress: (listener) => {
    const handler = (_event, progress) => listener(progress);
    ipcRenderer.on('products:progress', handler);
    return () => ipcRenderer.removeListener('products:progress', handler);
  },
  onAssistantUpdate: (listener) => {
    const handler = (_event, status) => listener(status);
    ipcRenderer.on('assistant:update-status', handler);
    return () => ipcRenderer.removeListener('assistant:update-status', handler);
  }
});
