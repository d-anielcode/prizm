'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

export function HeaderSearch() {
  const [value, setValue] = useState('')
  const [allPlayers, setAllPlayers] = useState<string[]>([])
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(-1)
  const router = useRouter()
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Fetch all player names once on mount
  useEffect(() => {
    fetch('/api/players')
      .then((r) => r.json())
      .then((names: string[]) => setAllPlayers(names))
      .catch(() => {})
  }, [])

  // Filter suggestions as user types
  useEffect(() => {
    const q = value.trim().toLowerCase()
    if (q.length < 1) {
      setSuggestions([])
      setOpen(false)
      return
    }
    const matches = allPlayers
      .filter((n) => n.toLowerCase().includes(q))
      .slice(0, 8)
    setSuggestions(matches)
    setOpen(matches.length > 0)
    setHighlighted(-1)
  }, [value, allPlayers])

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function navigate(name: string) {
    setOpen(false)
    setValue('')
    router.push('/props?search=' + encodeURIComponent(name))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const q = value.trim()
    if (!q) return
    if (highlighted >= 0 && suggestions[highlighted]) {
      navigate(suggestions[highlighted])
    } else {
      navigate(q)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((h) => Math.min(h + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((h) => Math.max(h - 1, -1))
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      <form onSubmit={handleSubmit}>
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none"
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => suggestions.length > 0 && setOpen(true)}
            placeholder="Search players..."
            autoComplete="off"
            className="w-8 sm:w-[280px] pl-9 pr-4 py-1.5 rounded-lg bg-transparent sm:bg-[#0e0b18] border border-transparent sm:border-white/[0.08] text-sm text-white placeholder:text-white/25 focus:outline-none focus:w-[200px] focus:bg-[#0e0b18] focus:border-[#e8a820]/40 focus:placeholder:text-white/25 transition-all duration-200 cursor-pointer focus:cursor-text"
          />
        </div>
      </form>

      {/* Autocomplete dropdown */}
      {open && suggestions.length > 0 && (
        <div className="absolute top-full mt-1.5 w-full rounded-xl border border-white/[0.10] bg-[#0e0b18] shadow-[0_8px_32px_rgba(0,0,0,0.6)] overflow-hidden z-50">
          {suggestions.map((name, i) => (
            <button
              key={name}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); navigate(name) }}
              onMouseEnter={() => setHighlighted(i)}
              className={[
                'w-full text-left px-4 py-2.5 text-sm transition-colors flex items-center gap-2',
                i === highlighted
                  ? 'bg-[#e8a820]/12 text-[#f0c060]'
                  : 'text-white/70 hover:bg-white/[0.05] hover:text-white',
              ].join(' ')}
            >
              <svg className="w-3 h-3 opacity-40 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
              </svg>
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
