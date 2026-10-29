/**
 * 渲染进程与主进程之间的最小桥接层。
 * 只暴露自动发布相关的三个能力，不做通用 IPC 通道。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('onecastAuto', {
  status: () => ipcRenderer.invoke('auto:status'),
  run: (payload) => ipcRenderer.invoke('auto:run', payload),
  cancel: () => ipcRenderer.invoke('auto:cancel'),
  openWorkbench: () => ipcRenderer.invoke('auto:workbench'),
  onProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('auto:progress', handler);
    return () => ipcRenderer.off('auto:progress', handler);
  }
});
