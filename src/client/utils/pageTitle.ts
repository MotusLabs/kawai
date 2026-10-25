/** Identify the server workspace independently of browser/session defaults. */
export function pageTitle(info?: {
  defaultProjectDir?: string | null
  cwd?: string | null
} | null): string {
  const directoryName = (path?: string | null) => path?.split('/').filter(Boolean).at(-1)
  const name = directoryName(info?.defaultProjectDir) || directoryName(info?.cwd)
  return name ? `${name} - Kawai` : 'Kawai'
}
