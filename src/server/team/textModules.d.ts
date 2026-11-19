// Text imports of markdown files (`import x from './file.md' with { type:
// 'text' }`): Bun inlines the file's contents as a string, so the compiled
// binary carries them (starter-team-setup D1: the starter group templates).
declare module '*.md' {
  const text: string
  export default text
}
