import React, { useCallback, useEffect, useRef } from 'react'
import { cn } from 'cn'

/**
 * Wraps a card in a pointer-driven 3D tilt: the surface leans toward the
 * cursor, lifts off the page, and shows a soft glare that follows the pointer.
 *
 * Motion is written straight to the DOM inside a requestAnimationFrame throttle
 * (never React state), so a grid of cards can follow the pointer without
 * re-rendering. Honors `prefers-reduced-motion` and ignores touch pointers.
 */
interface TiltCardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode
  /** Maximum lean in degrees on either axis. */
  maxTilt?: number
  /** How far the card pops toward the viewer, in pixels. */
  lift?: number
  /** Freeze the tilt (e.g. while the card is being dragged). */
  disabled?: boolean
  /** Session id, surfaced as `data-session-card` for drag lookups. */
  cardId?: string
}

const DEFAULT_MAX_TILT = 8
const DEFAULT_LIFT = 12
const SCALE = 1.02
const PERSPECTIVE = 900

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export default function TiltCard({
  children,
  className,
  maxTilt = DEFAULT_MAX_TILT,
  lift = DEFAULT_LIFT,
  disabled = false,
  cardId,
  ...rest
}: TiltCardProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const glareRef = useRef<HTMLDivElement>(null)
  const frame = useRef<number | null>(null)

  const reset = useCallback((): void => {
    const el = ref.current
    if (!el) return
    el.style.transition = 'transform 320ms cubic-bezier(0.22, 1, 0.36, 1)'
    el.style.transform = ''
    el.style.willChange = ''
    if (glareRef.current) glareRef.current.style.opacity = '0'
  }, [])

  const applyTilt = useCallback(
    (nx: number, ny: number): void => {
      const el = ref.current
      if (!el) return
      el.style.transition = 'transform 80ms linear'
      el.style.willChange = 'transform'
      el.style.transform = `perspective(${PERSPECTIVE}px) rotateX(${(-ny * maxTilt).toFixed(
        2
      )}deg) rotateY(${(nx * maxTilt).toFixed(2)}deg) translateZ(${lift}px) scale(${SCALE})`
      if (glareRef.current) {
        glareRef.current.style.setProperty('--gx', `${((nx + 1) / 2) * 100}%`)
        glareRef.current.style.setProperty('--gy', `${((ny + 1) / 2) * 100}%`)
        glareRef.current.style.opacity = '0.45'
      }
    },
    [lift, maxTilt]
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (disabled || event.pointerType === 'touch' || prefersReducedMotion()) return
      const el = ref.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      // Normalize the cursor to [-1, 1] on each axis, relative to the center.
      const nx = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1))
      const ny = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1))
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        applyTilt(nx, ny)
      })
    },
    [applyTilt, disabled]
  )

  const handlePointerLeave = useCallback((): void => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
    reset()
  }, [reset])

  // Snap back to rest the moment the card is disabled (drag start) so it does
  // not hang mid-lean while the pointer is captured by the drag.
  useEffect(() => {
    if (disabled) reset()
  }, [disabled, reset])

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    },
    []
  )

  return (
    <div
      ref={ref}
      data-session-card={cardId}
      {...rest}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      className={cn('relative w-full [transform-style:preserve-3d] hover:z-10', className)}
    >
      {children}
      <div
        ref={glareRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-xl opacity-0 transition-opacity duration-300"
        style={{
          background:
            'radial-gradient(circle at var(--gx, 50%) var(--gy, 50%), color-mix(in oklab, var(--primary) 20%, transparent), transparent 60%)'
        }}
      />
    </div>
  )
}
