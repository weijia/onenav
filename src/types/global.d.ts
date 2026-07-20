// 为 universal-sync-v2 浏览器版本提供类型声明
declare module 'universal-sync-v2/browser' {
  export class SyncEngine {
    constructor(db: any, fs: any, options: any)
    initialize(): Promise<void>
    pull(): Promise<void>
    sync(): Promise<void>
  }

  export function sync(db: any, fs: any, basePath: string, options?: any): Promise<void>
}

// 主模块
declare module 'universal-sync-v2' {
  export class SyncEngine {
    constructor(db: any, fs: any, options: any)
    initialize(): Promise<void>
    pull(): Promise<void>
    sync(): Promise<void>
  }

  export function sync(db: any, fs: any, basePath: string, options?: any): Promise<void>
}
