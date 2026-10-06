/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['"JetBrains Mono"', '"SF Mono"', '"Fira Code"', 'monospace'],
      },
      colors: {
        base: 'var(--bg-base)',
        elevated: 'var(--bg-elevated)',
        surface: 'var(--bg-surface)',
        hover: 'var(--bg-hover)',
        primary: 'var(--text-primary)',
        secondary: 'var(--text-secondary)',
        muted: 'var(--text-muted)',
        border: 'var(--border)',
        'border-subtle': 'var(--border-subtle)',
        working: 'var(--working)',
        approval: 'var(--approval)',
        waiting: 'var(--waiting)',
        danger: 'var(--danger)',
        accent: 'var(--accent)',
        'chat-danger': 'var(--chat-danger)',
        'chat-wire-out': 'var(--chat-wire-out)',
        'chat-wire-in': 'var(--chat-wire-in)',
        'chat-wire-stderr': 'var(--chat-wire-stderr)',
      },
    },
  },
  plugins: [],
}
