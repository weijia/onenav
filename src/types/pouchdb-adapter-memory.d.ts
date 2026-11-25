// `pouchdb-adapter-memory` 只用于 Node 测试环境，本身不带类型声明。
declare module 'pouchdb-adapter-memory' {
  const adapter: any
  export default adapter
}
