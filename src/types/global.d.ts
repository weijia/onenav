// universal-sync-v2 没有正确的 Node.js 入口文件，提供类型声明
declare module 'universal-sync-v2' {
  export class SyncEngine {
    constructor(db: any, fs: any, options: any)
    initialize(): Promise<void>
    pull(): Promise<void>
    sync(): Promise<void>
  }

  export function sync(db: any, fs: any, basePath: string, options?: any): Promise<void>
}

// 浏览器版本
declare module 'universal-sync-v2/dist/browser.js' {
  export class SyncEngine {
    constructor(db: any, fs: any, options: any)
    initialize(): Promise<void>
    pull(): Promise<void>
    sync(): Promise<void>
  }

  export function sync(db: any, fs: any, basePath: string, options?: any): Promise<void>
}
