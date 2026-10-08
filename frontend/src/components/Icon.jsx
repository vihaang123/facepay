/** FacePay icon set: one stroke style (24px grid, 1.8 stroke, round caps) so every screen reads as one product. */
const PATHS = {
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  hourglass: <path d="M7 4h10M7 20h10M8 4v3.5c0 1.5 1.2 2.6 2.5 3.5L12 12l1.5-1c1.3-.9 2.5-2 2.5-3.5V4M8 20v-3.5c0-1.5 1.2-2.6 2.5-3.5L12 12l1.5 1c1.3.9 2.5 2 2.5 3.5V20" />,
  pending: <><circle cx="12" cy="12" r="8" strokeDasharray="3 3.2" /><path d="M12 8v4l2.5 1.5" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="9.5" rx="2.5" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
  shield: <><path d="M12 3.5l7 2.8v5.4c0 4.2-2.8 7.4-7 8.8-4.2-1.4-7-4.6-7-8.8V6.3l7-2.8z" /><path d="M9 12l2.2 2.2L15.2 10" /></>,
  home: <path d="M4 11l8-6.5 8 6.5M6 9.5V19a1 1 0 0 0 1 1h3.5v-5h3v5H17a1 1 0 0 0 1-1V9.5" />,
  receipt: <><path d="M6 3.5h12v17l-3-1.8-3 1.8-3-1.8-3 1.8v-17z" /><path d="M9 8.5h6M9 12h6" /></>,
  face: <><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" /><path d="M9 10.5v1M15 10.5v1M9.5 15c1.5 1.2 3.5 1.2 5 0" /></>,
  user: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c.6-3.6 3.4-5.5 7-5.5s6.4 1.9 7 5.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  camera: <><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7H8l1.2-2h5.6L16 7h2.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-9z" /><circle cx="12" cy="13" r="3.2" /></>,
  chevron: <path d="M9 6l6 6-6 6" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  store: <><path d="M4 9.5L5.5 4h13L20 9.5M4 9.5c0 1.4 1.1 2.5 2.5 2.5S9 10.9 9 9.5c0 1.4 1.1 2.5 2.5 2.5S14 10.9 14 9.5c0 1.4 1.1 2.5 2.5 2.5S19 10.9 19 9.5M5.5 12v8h13v-8" /></>,
  alert: <><path d="M12 4l9 15.5H3L12 4z" /><path d="M12 10v4M12 17v.01" /></>,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  print: <><path d="M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1h-2" /><rect x="7" y="14" width="10" height="6" rx="1" /></>,
  logout: <path d="M10 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h4M14 8l4 4-4 4M18 12H9" />,
  cpu: <><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M10 3.5V7M14 3.5V7M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5" /></>,
  database: <><ellipse cx="12" cy="6.5" rx="7" ry="2.8" /><path d="M5 6.5v11c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-11M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8" /></>,
  refresh: <path d="M19 8a7.5 7.5 0 0 0-13.2-1.5M5 4v3.5h3.5M5 16a7.5 7.5 0 0 0 13.2 1.5M19 20v-3.5h-3.5" />,
}

export default function Icon({ name, className = 'h-5 w-5', ...props }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
      {PATHS[name]}
    </svg>
  )
}
