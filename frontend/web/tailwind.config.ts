import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Dark theme tokens — sourced from Pack 2 pack2-capture.html.
        'bg-base': '#050507',
        'bg-elevated': '#0d0d12',
        'bg-card': '#16161e',
        'bg-card-hover': '#1c1c26',
        'border-subtle': '#262633',
        'border-strong': '#3a3a4d',
        'text-primary': '#e8e8f0',
        'text-secondary': '#9999b3',
        'text-muted': '#6b6b80',
        'accent-cool': '#7be0e0',
        'accent-warm': '#ffd166',
        'accent-error': '#ef5b5b',
        'accent-success': '#83e577',
        // Object-class colours (wireframe)
        'em-person': '#ff9e80',
        'em-org': '#80d8ff',
        'em-service': '#b388ff',
        'em-product': '#82b1ff',
        'em-concept': '#ccff90',
        'em-event': '#ffd180',
        'em-knowledge': '#a7ffeb',
        'em-resource': '#f8bbd0',
        'em-problem': '#ef9a9a',
      },
      fontFamily: {
        sans: ['var(--font-ibm-plex-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-ibm-plex-mono)', 'monospace'],
      },
      fontSize: {
        'xxs': '0.65rem',
      },
    },
  },
  plugins: [],
};

export default config;
