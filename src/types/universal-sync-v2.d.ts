declare module 'universal-sync-v2' {
  export interface SyncOptions {
    basePath: string
    maxFileSize?: number
    mergeThreshold?: number
    autoMerge?: boolean
  }

  export class SyncEngine {
    constructor(db: PouchDB.Database, fs: any, options: SyncOptions)
    initialize(): Promise<void>
    pull(): Promise<void>
    sync(): Promise<void>
  }

  export function sync(
    db: PouchDB.Database,
    fs: any,
    basePath: string,
    options?: Partial<SyncOptions>
  ): Promise<void>
}
