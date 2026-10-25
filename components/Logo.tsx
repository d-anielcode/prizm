export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="prism-primary" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#A29BFE" />
          <stop offset="50%"  stopColor="#6C5CE7" />
          <stop offset="100%" stopColor="#5A4BD1" />
        </linearGradient>
        <linearGradient id="prism-face" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#A29BFE" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#6C5CE7" stopOpacity="0.5" />
        </linearGradient>
      </defs>
      {/* Left face */}
      <polygon points="16,3 4,27 16,22" fill="url(#prism-face)" opacity="0.6" />
      {/* Right bright face */}
      <polygon points="16,3 28,27 16,22" fill="url(#prism-primary)" />
      {/* Bottom bar */}
      <polygon points="4,27 28,27 16,22" fill="url(#prism-primary)" opacity="0.4" />
      {/* Outline */}
      <polygon
        points="16,3 28,27 4,27"
        fill="none"
        stroke="url(#prism-primary)"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      {/* Inner 3D line */}
      <line x1="16" y1="3" x2="16" y2="22" stroke="#A29BFE" strokeWidth="0.8" opacity="0.7" />
    </svg>
  )
}
