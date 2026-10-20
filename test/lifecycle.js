const cleanups = new Map()
export function trackDisposer(cwd, dispose) {
  const list = cleanups.get(cwd) ?? []
  list.push(dispose); cleanups.set(cwd, list)
}
export async function disposeHosts(cwd) {
  const list = cleanups.get(cwd) ?? []
  cleanups.delete(cwd)
  await Promise.all(list.map(dispose => dispose?.()))
}
