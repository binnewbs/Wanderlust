import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Plus,
  Play,
  BarChart3,
  Trash2,
  Calendar,
  Layers,
  PlayCircle,
  Pin,
  GripVertical
} from 'lucide-react'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty'
import { cn } from 'cn'
import { useSessionStore, type SavedSession } from '@/store/session'
import { formatCurrency, formatPlainBalance } from '@/lib/analytics'
import TiltCard from './TiltCard'

interface SessionsMenuProps {
  onNewSession: () => void
  onResumeSession: (sessionId: string) => void
  onViewAnalytics: (sessionId: string) => void
}

// Pendulum feel for the hanging drag preview: cursor velocity (px/ms) maps to a
// lean, then a damped spring chases it so the card swings past and settles.
const SWAY_MAX_DEG = 13
const SWAY_IDLE_DEG = 1.5
const SWAY_VELOCITY_TO_DEG = 5.5
const SWAY_STIFFNESS = 0.12
const SWAY_DAMPING = 0.82

/** Insert `draggedId` next to `targetId` within one group, returning a new array. */
function moveWithinGroup(
  group: SavedSession[],
  draggedId: string,
  targetId: string,
  edge: 'before' | 'after'
): SavedSession[] {
  const dragged = group.find((s) => s.id === draggedId)
  if (!dragged) return group
  const without = group.filter((s) => s.id !== draggedId)
  const targetIndex = without.findIndex((s) => s.id === targetId)
  if (targetIndex === -1) return group
  const insertAt = edge === 'before' ? targetIndex : targetIndex + 1
  const next = without.slice()
  next.splice(insertAt, 0, dragged)
  return next
}

export default function SessionsMenu({
  onNewSession,
  onResumeSession,
  onViewAnalytics
}: SessionsMenuProps): React.JSX.Element {
  const savedSessions = useSessionStore((s) => s.savedSessions)
  const deleteSavedSession = useSessionStore((s) => s.deleteSavedSession)
  const toggleSavedSessionPin = useSessionStore((s) => s.toggleSavedSessionPin)
  const setSavedSessionsOrder = useSessionStore((s) => s.setSavedSessionsOrder)

  const [sessionToDelete, setSessionToDelete] = useState<SavedSession | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: 'before' | 'after' } | null>(
    null
  )
  // Custom "hanging" drag preview (the native drag image is a static bitmap).
  const [dragGhost, setDragGhost] = useState<{
    html: string
    width: number
    x: number
    y: number
  } | null>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const swingRef = useRef<HTMLDivElement>(null)
  // Pendulum state, mutated inside the rAF loop (deliberately not React state).
  const swing = useRef({
    lastX: 0,
    lastT: 0,
    vx: 0,
    angle: 0,
    vel: 0,
    target: 0,
    lastEventT: 0,
    lastFrameT: 0
  })

  // Pinned sessions are hoisted to the top; order within each group is manual.
  const pinnedSessions = useMemo(() => savedSessions.filter((s) => s.pinned), [savedSessions])
  const unpinnedSessions = useMemo(() => savedSessions.filter((s) => !s.pinned), [savedSessions])
  const displaySessions = useMemo(
    () => [...pinnedSessions, ...unpinnedSessions],
    [pinnedSessions, unpinnedSessions]
  )

  const draggedSession = useMemo(
    () => (draggedId ? (savedSessions.find((s) => s.id === draggedId) ?? null) : null),
    [draggedId, savedSessions]
  )

  // Follow the cursor with the ghost, sway it against cursor velocity like a
  // pendulum, and clean up when the drag ends. Position + rotation are written
  // straight to the DOM (not React state) so nothing re-renders per drag event.
  useLayoutEffect(() => {
    if (!dragGhost) return
    const el = ghostRef.current
    if (el) el.style.transform = `translate3d(${dragGhost.x}px, ${dragGhost.y}px, 0)`

    const p = swing.current
    const start = performance.now()
    p.lastX = dragGhost.x
    p.lastT = start
    p.vx = 0
    p.angle = 0
    p.vel = 0
    p.target = 0
    p.lastEventT = start
    p.lastFrameT = start

    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // One integration step of the damped spring toward the current lean target.
    const step = (now: number): void => {
      if (now - p.lastEventT > 70) p.target = 0
      const lean = Math.max(-SWAY_MAX_DEG, Math.min(SWAY_MAX_DEG, p.target))
      const goal = reduceMotion ? 0 : lean + Math.sin(now / 900) * SWAY_IDLE_DEG
      p.vel += (goal - p.angle) * SWAY_STIFFNESS
      p.vel *= SWAY_DAMPING
      p.angle += p.vel
      const node = swingRef.current
      if (node) node.style.transform = `rotate(${p.angle.toFixed(2)}deg)`
    }

    let frame = 0
    const loop = (now: number): void => {
      p.lastFrameT = now
      step(now)
      frame = requestAnimationFrame(loop)
    }
    if (!reduceMotion) frame = requestAnimationFrame(loop)

    const move = (event: DragEvent): void => {
      const node = ghostRef.current
      if (node) node.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0)`

      const now = performance.now()
      const dt = now - p.lastT
      if (dt > 0 && dt < 250) {
        // Smooth the instantaneous velocity so the lean doesn't twitch.
        const instantVx = (event.clientX - p.lastX) / dt
        p.vx = p.vx * 0.55 + instantVx * 0.45
      }
      p.lastX = event.clientX
      p.lastT = now
      p.lastEventT = now
      // Cursor moving left (negative vx) swings the card's body to the right.
      p.target = reduceMotion ? 0 : p.vx * SWAY_VELOCITY_TO_DEG
      // Fallback: if rAF is throttled during the native drag loop, keep the
      // spring alive from the event stream.
      if (!reduceMotion && now - p.lastFrameT > 120) step(now)
    }

    const end = (): void => {
      setDragGhost(null)
      setDropTarget(null)
    }
    window.addEventListener('dragover', move)
    window.addEventListener('drag', move)
    window.addEventListener('dragend', end)
    window.addEventListener('drop', end)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('dragover', move)
      window.removeEventListener('drag', move)
      window.removeEventListener('dragend', end)
      window.removeEventListener('drop', end)
    }
  }, [dragGhost])

  const clearDrag = (): void => {
    setDraggedId(null)
    setDropTarget(null)
    setDragGhost(null)
  }

  const handleDragStart = (
    event: React.DragEvent<HTMLButtonElement>,
    session: SavedSession
  ): void => {
    setDraggedId(session.id)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', session.id)

    const wrapper = event.currentTarget.closest('[data-session-card]')
    if (!(wrapper instanceof HTMLElement)) return
    const rect = wrapper.getBoundingClientRect()

    // Clone the card's DOM for the hanging preview, stripping the mount-in
    // animation so it doesn't replay on the clone.
    const cardEl = wrapper.querySelector('[data-slot="card"]')
    let html = ''
    if (cardEl) {
      const clone = cardEl.cloneNode(true) as HTMLElement
      clone.classList.remove(
        'animate-in',
        'fade-in',
        'slide-in-from-bottom-3',
        'zoom-in-95',
        'fill-mode-backwards'
      )
      clone.removeAttribute('style')
      html = clone.outerHTML
    }
    setDragGhost({ html, width: rect.width, x: event.clientX, y: event.clientY })

    // Hide the browser's static drag bitmap so our animated ghost is the only
    // thing the user sees. Best-effort: engines can reject this outside a
    // trusted drag operation.
    try {
      const blank = document.createElement('canvas')
      blank.width = 1
      blank.height = 1
      event.dataTransfer.setDragImage(blank, 0, 0)
    } catch {
      // ignore
    }
  }

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>, session: SavedSession): void => {
    if (!draggedSession || draggedSession.id === session.id) return
    // Reordering is confined to a group — pin/unpin happens via the pin button.
    if (Boolean(draggedSession.pinned) !== Boolean(session.pinned)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const edge = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
    setDropTarget((prev) =>
      prev?.id === session.id && prev.edge === edge ? prev : { id: session.id, edge }
    )
  }

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>, session: SavedSession): void => {
    const related = event.relatedTarget
    if (related instanceof Node && event.currentTarget.contains(related)) return
    setDropTarget((prev) => (prev?.id === session.id ? null : prev))
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>, session: SavedSession): void => {
    event.preventDefault()
    const dragged = draggedSession
    if (!dragged || dragged.id === session.id) {
      clearDrag()
      return
    }
    if (Boolean(dragged.pinned) !== Boolean(session.pinned)) {
      clearDrag()
      return
    }
    const edge = dropTarget?.id === session.id ? dropTarget.edge : 'before'
    const group = dragged.pinned ? pinnedSessions : unpinnedSessions
    const reordered = moveWithinGroup(group, dragged.id, session.id, edge)
    const nextPinned = dragged.pinned ? reordered : pinnedSessions
    const nextUnpinned = dragged.pinned ? unpinnedSessions : reordered
    setSavedSessionsOrder([...nextPinned, ...nextUnpinned].map((s) => s.id))
    clearDrag()
  }

  // Keyboard fallback for the grip: nudge the card within its group.
  const handleGripKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    session: SavedSession
  ): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const group = session.pinned ? pinnedSessions : unpinnedSessions
    const index = group.findIndex((s) => s.id === session.id)
    const swapIndex = index + (event.key === 'ArrowRight' ? 1 : -1)
    if (index === -1 || swapIndex < 0 || swapIndex >= group.length) return
    const next = group.slice()
    ;[next[index], next[swapIndex]] = [next[swapIndex], next[index]]
    const nextPinned = session.pinned ? next : pinnedSessions
    const nextUnpinned = session.pinned ? unpinnedSessions : next
    setSavedSessionsOrder([...nextPinned, ...nextUnpinned].map((s) => s.id))
  }

  if (savedSessions.length === 0) {
    return (
      <Empty className="h-full animate-in fade-in zoom-in-95 duration-300">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <PlayCircle />
          </EmptyMedia>
          <EmptyTitle>No session yet</EmptyTitle>
          <EmptyDescription>
            Download a market range from Dukascopy (cached locally for reuse) and replay it on the
            chart. Your data stays on this machine.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={onNewSession}>
            <Plus data-icon="inline-start" />
            Start a new backtest session
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-background p-6 sm:p-8">
      {/* Menu Header */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4 pb-3">
        <div>
          <div className="flex items-center gap-2.5">
            <Layers className="size-5 text-primary" />
            <h2 className="text-xl font-bold tracking-tight text-foreground">Backtest Sessions</h2>
            <Badge variant="secondary" className="font-mono text-xs">
              {savedSessions.length} {savedSessions.length === 1 ? 'session' : 'sessions'}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Select a session to resume trading, inspect detailed analytics and trade journal, or
            start a new backtest. Pin favourites to the top, or drag a card by its grip to reorder.
          </p>
        </div>
      </div>

      {/* Sessions Grid */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),340px))] gap-5">
        {displaySessions.map((s: SavedSession, index) => {
          const closedOrders = s.orders.filter((o) => o.status === 'closed')
          const netPnl = s.balance - s.startBalance
          const isProfitable = netPnl >= 0
          const wins = closedOrders.filter((o) => (o.pnl ?? 0) > 0.001).length
          const winRate = closedOrders.length > 0 ? (wins / closedOrders.length) * 100 : 0
          const pendingActive = s.orders.filter((o) => o.status !== 'closed').length
          const isDragging = draggedId === s.id
          const indicator = dropTarget?.id === s.id ? dropTarget.edge : null

          return (
            <TiltCard
              key={s.id}
              cardId={s.id}
              disabled={isDragging}
              className={cn('group/card', isDragging && 'opacity-50')}
              onDragOver={(e) => handleDragOver(e, s)}
              onDragLeave={(e) => handleDragLeave(e, s)}
              onDrop={(e) => handleDrop(e, s)}
            >
              <Card
                className={cn(
                  'relative flex aspect-square w-full flex-col justify-between border-border/80 bg-card/80 transition-all animate-in fade-in slide-in-from-bottom-3 zoom-in-95 duration-200 fill-mode-backwards hover:border-primary/40 hover:shadow-lg',
                  s.pinned && 'border-primary/30'
                )}
                style={{ animationDelay: `${Math.min(index * 45, 450)}ms` }}
              >
                {/* Card controls: pin (always interactive once pinned) + drag grip */}
                <div className="absolute right-2.5 top-2.5 z-10 flex items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => toggleSavedSessionPin(s.id)}
                    title={s.pinned ? 'Unpin session' : 'Pin session'}
                    aria-label={s.pinned ? 'Unpin session' : 'Pin session'}
                    aria-pressed={Boolean(s.pinned)}
                    className={cn(
                      'text-muted-foreground transition-opacity hover:text-foreground',
                      s.pinned
                        ? 'pointer-events-auto text-primary opacity-100 hover:text-primary'
                        : 'pointer-events-none opacity-0 group-hover/card:pointer-events-auto group-hover/card:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100'
                    )}
                  >
                    <Pin className={cn(s.pinned && 'fill-current')} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    draggable
                    onDragStart={(e) => handleDragStart(e, s)}
                    onDragEnd={clearDrag}
                    onKeyDown={(e) => handleGripKeyDown(e, s)}
                    title="Drag to reorder (or use ← / →)"
                    aria-label="Drag to reorder"
                    className="pointer-events-none cursor-grab text-muted-foreground opacity-0 transition-opacity hover:text-foreground active:cursor-grabbing group-hover/card:pointer-events-auto group-hover/card:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
                  >
                    <GripVertical />
                  </Button>
                </div>

                <CardHeader className="p-4 pb-2">
                  <div className="min-w-0 pr-12">
                    <CardTitle className="truncate text-base font-semibold text-foreground">
                      {s.name}
                    </CardTitle>
                    <CardDescription className="mt-1 flex items-center gap-1.5 text-xs">
                      <Calendar className="size-3 shrink-0 text-muted-foreground" />
                      <span className="truncate">
                        {s.startDate} → {s.endDate}
                      </span>
                    </CardDescription>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className="shrink-0 font-semibold uppercase tracking-wider"
                      >
                        {s.asset.label}
                      </Badge>
                      <span className="text-[11px] text-muted-foreground">
                        Updated {new Date(s.updatedAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="p-4 py-1">
                  <div className="grid grid-cols-2 gap-2 rounded-lg border border-border/50 bg-muted/20 p-2.5 text-xs">
                    <div>
                      <span className="text-[10px] uppercase text-muted-foreground">Net PnL</span>
                      <div
                        className={`font-mono text-sm font-bold ${
                          isProfitable ? 'text-chart-2' : 'text-destructive'
                        }`}
                      >
                        {formatCurrency(netPnl)}
                      </div>
                    </div>

                    <div>
                      <span className="text-[10px] uppercase text-muted-foreground">Balance</span>
                      <div className="font-mono text-sm font-semibold text-foreground">
                        {formatPlainBalance(s.balance)}
                      </div>
                    </div>

                    <div className="border-t border-border/40 pt-1.5">
                      <span className="text-[10px] uppercase text-muted-foreground">
                        Closed Trades
                      </span>
                      <div className="font-mono font-medium text-foreground">
                        {closedOrders.length}{' '}
                        <span className="text-[10px] text-muted-foreground">
                          ({winRate.toFixed(0)}% win)
                        </span>
                      </div>
                    </div>

                    <div className="border-t border-border/40 pt-1.5">
                      <span className="text-[10px] uppercase text-muted-foreground">
                        Open / Pending
                      </span>
                      <div className="font-mono font-medium text-foreground">
                        {pendingActive} orders
                      </div>
                    </div>
                  </div>
                </CardContent>

                <CardFooter className="flex items-center justify-between border-t border-border/50 p-4 pt-2.5">
                  <div className="flex items-center gap-2">
                    <Button size="sm" onClick={() => onResumeSession(s.id)}>
                      <Play data-icon="inline-start" />
                      Resume
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => onViewAnalytics(s.id)}>
                      <BarChart3 data-icon="inline-start" />
                      Analytics
                    </Button>
                  </div>

                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setSessionToDelete(s)}
                    title="Delete session"
                    aria-label="Delete session"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 />
                  </Button>
                </CardFooter>
              </Card>

              {/* Insertion marker while dragging within this group */}
              {indicator && (
                <span
                  aria-hidden
                  className={cn(
                    'pointer-events-none absolute inset-y-3 w-0.5 rounded-full bg-primary',
                    indicator === 'before' ? '-left-1.5' : '-right-1.5'
                  )}
                />
              )}
            </TiltCard>
          )
        })}
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={sessionToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setSessionToDelete(null)
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete session?</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{' '}
              <strong className="text-foreground">{sessionToDelete?.name}</strong>? All simulated
              orders and session history will be permanently removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSessionToDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (sessionToDelete) {
                  deleteSavedSession(sessionToDelete.id)
                  setSessionToDelete(null)
                }
              }}
            >
              <Trash2 data-icon="inline-start" />
              Delete Session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Hanging drag preview: a clone of the card dangling from the cursor on
          a string, swaying like a pendulum while you drag it around. */}
      {dragGhost &&
        createPortal(
          <div
            ref={ghostRef}
            aria-hidden
            className="pointer-events-none fixed left-0 top-0 z-[100] [will-change:transform]"
          >
            <div className="-translate-x-1/2">
              <div ref={swingRef} className="origin-top [will-change:transform]">
                <span className="mx-auto block size-2.5 rounded-full border-2 border-primary bg-background shadow-sm" />
                <span className="mx-auto block h-3 w-px bg-primary/60" />
                <div
                  className="origin-top scale-95 drop-shadow-2xl"
                  style={{ width: dragGhost.width }}
                  dangerouslySetInnerHTML={{ __html: dragGhost.html }}
                />
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
