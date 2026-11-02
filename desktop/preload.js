const { contextBridge, ipcRenderer } = require('electron')

const bridge = Object.freeze({
  isDesktop: true,
  chooseFolder: (uid) => ipcRenderer.invoke('fullon:choose-folder', uid),
  getBrokerInfo: () => ipcRenderer.invoke('fullon:broker-info'),
  listDirectory: (uid, root, parts) => ipcRenderer.invoke('fullon:list-directory', uid, root, parts),
  readFile: (uid, root, parts) => ipcRenderer.invoke('fullon:read-file', uid, root, parts),
  forgetRoot: (uid) => ipcRenderer.invoke('fullon:forget-root', uid)
})

contextBridge.exposeInMainWorld('fullonDesktop', bridge)
