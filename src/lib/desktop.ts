export interface DesktopAdapter {
  readonly available: boolean;
  autostart(): Promise<boolean>;
  setAutostart(enabled: boolean): Promise<boolean>;
  openDataDirectory(): Promise<void>;
}

/** Browser previews do not claim support for native preferences. */
export const browserDesktop: DesktopAdapter = {
  available: false,
  async autostart() {
    return false;
  },
  async setAutostart() {
    throw new Error("当前无法更改启动设置");
  },
  async openDataDirectory() {
    throw new Error("当前无法打开文件夹");
  },
};
