// Shared markdown renderer: element overrides styled with theme tokens
// (no typography plugin). Used by the chat view and the session log preview,
// so both render assistant text identically.
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

// Tailwind-styled element overrides for rendered markdown (no typography plugin).
const markdownComponents: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent underline underline-offset-2 hover:text-primary"
    >
      {children}
    </a>
  ),
  // Task lists (remark-gfm) carry contains-task-list and render their own
  // checkboxes, so they drop the marker and left padding.
  ul: ({ children, className }) => (
    <ul className={className?.includes('contains-task-list') ? 'my-2 space-y-1 list-none pl-0' : 'my-2 list-disc space-y-1 pl-5'}>
      {children}
    </ul>
  ),
  ol: ({ children, className }) => (
    <ol className={className?.includes('contains-task-list') ? 'my-2 space-y-1 list-none pl-0' : 'my-2 list-decimal space-y-1 pl-5'}>
      {children}
    </ol>
  ),
  li: ({ children, className }) => (
    <li className={className ? `leading-6 ${className}` : 'leading-6'}>{children}</li>
  ),
  h1: ({ children }) => <h1 className="mb-1 mt-3 text-base font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1 mt-3 text-sm font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-3 text-sm font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-1 mt-3 text-sm font-semibold first:mt-0">{children}</h4>,
  h5: ({ children }) => <h5 className="mb-1 mt-3 text-sm font-semibold first:mt-0">{children}</h5>,
  h6: ({ children }) => <h6 className="mb-1 mt-3 text-sm font-semibold first:mt-0">{children}</h6>,
  strong: ({ children }) => <strong className="font-semibold text-primary">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="line-through text-secondary">{children}</del>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-secondary">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
  pre: ({ children }) => (
    // Nested code styling is reset so a one-line fenced block with no language
    // doesn't get the inline chip treatment; styling comes from position, not content.
    <pre className="my-2 overflow-x-auto rounded bg-base p-3 text-xs leading-relaxed text-secondary [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit">
      {children}
    </pre>
  ),
  code: ({ className, children }) => {
    const text = String(children ?? '')
    // Block code carries a language-* class (fenced) or spans multiple lines;
    // everything else is inline and gets the chip treatment.
    const isBlock = (className?.includes('language-') ?? false) || text.includes('\n')
    if (isBlock) {
      return <code className={className}>{children}</code>
    }
    return <code className="rounded bg-surface px-1 py-0.5 text-[0.9em] text-primary">{children}</code>
  },
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border px-2 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
}

export default function Markdown({ content }: { content: string }) {
  return (
    <div className="min-w-0 break-words text-sm leading-6 text-primary [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
