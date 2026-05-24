// 检测 URL 是否可连接
const CHECK_TIMEOUT = 5000 // 5秒超时

export async function checkUrlReachable(url: string): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), CHECK_TIMEOUT)
    await fetch(url, {
      mode: 'no-cors',
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    return true
  } catch {
    return false
  }
}
