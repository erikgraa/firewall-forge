const paths = {
  import: 'M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5',
  export: 'M12 15V3m-4 4 4-4 4 4M4 15v5h16v-5',
  clear: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
  add: 'M12 4v16M4 12h16',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  download: 'M12 3v12m-4-4 4 4 4-4M4 19h16',
  share: 'M14 4h6v6M20 4 10 14M10 6H4v14h14v-6',
  ssh: 'M3 5h18v14H3zM6 9l3 3-3 3M12 15h5',
  web: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M2 12h20M12 2c5 5 5 15 0 20M12 2c-5 5-5 15 0 20',
  dns: 'M3 3h18v6H3zM7 6h.01M12 9v6M4 21v-6h16v6M12 15v6',
} as const

export default function ButtonIcon({ name }: { name: keyof typeof paths }) {
  return <svg className="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>
}
