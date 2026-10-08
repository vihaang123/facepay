/** Corner brackets of the face frame, the one visual motif of FacePay (logo, hero, scan screen). */
export function Brackets({ className = '', color = 'border-scan-edge' }) {
  const c = `absolute h-9 w-9 ${color}`
  return (
    <span aria-hidden="true" className={`pointer-events-none absolute inset-0 ${className}`}>
      <span className={`${c} left-0 top-0 rounded-tl-2xl border-l-[3px] border-t-[3px]`} />
      <span className={`${c} right-0 top-0 rounded-tr-2xl border-r-[3px] border-t-[3px]`} />
      <span className={`${c} bottom-0 left-0 rounded-bl-2xl border-b-[3px] border-l-[3px]`} />
      <span className={`${c} bottom-0 right-0 rounded-br-2xl border-b-[3px] border-r-[3px]`} />
    </span>
  )
}

/** Head-and-shoulders outline used as a positioning guide and in the landing illustration. */
export function FaceGuide({ className = '' }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 120 150" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className={className}>
      <ellipse cx="60" cy="58" rx="27" ry="34" strokeDasharray="4 5" />
      <path d="M12 150c3-30 22-44 48-44s45 14 48 44" strokeDasharray="4 5" />
    </svg>
  )
}
