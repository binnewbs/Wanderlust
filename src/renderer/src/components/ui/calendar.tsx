import * as React from 'react'
import { cn } from 'cn'
import {
  DayPicker,
  getDefaultClassNames,
  type DayButton,
  type DropdownProps,
  type Locale
} from 'react-day-picker'

import { Button, buttonVariants } from '@/components/ui/button'
import { ChevronLeftIcon, ChevronRightIcon, ChevronDownIcon } from 'lucide-react'

function CalendarDropdown({
  options,
  value,
  onChange,
  disabled,
  'aria-label': ariaLabel
}: DropdownProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)

  const selectedOption = options?.find((o) => o.value === Number(value))

  // Close when clicking outside
  React.useEffect(() => {
    if (!open) return
    const handlePointerDown = (e: MouseEvent | TouchEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('touchstart', handlePointerDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('touchstart', handlePointerDown)
    }
  }, [open])

  // Scroll active option into view when opened
  React.useEffect(() => {
    if (open && listRef.current) {
      const active = listRef.current.querySelector('[data-selected="true"]') as HTMLElement | null
      if (active) {
        listRef.current.scrollTop =
          active.offsetTop - listRef.current.clientHeight / 2 + active.clientHeight / 2
      }
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen((prev) => !prev)
        }}
        className={cn(
          'flex h-7 items-center gap-1 rounded-md border border-input/60 bg-background/50 px-2 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
          open && 'bg-muted ring-1 ring-ring'
        )}
      >
        <span>{selectedOption?.label ?? value}</span>
        <ChevronDownIcon
          className={cn(
            'size-3.5 text-muted-foreground transition-transform duration-200',
            open && 'rotate-180'
          )}
        />
      </button>

      {open && (
        <div
          ref={listRef}
          className="absolute top-full left-1/2 z-[100] mt-1 max-h-48 min-w-[5.5rem] -translate-x-1/2 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-2xl animate-in fade-in-0 zoom-in-95"
        >
          {options?.map((option) => {
            const isSelected = option.value === Number(value)
            return (
              <button
                key={option.value}
                type="button"
                data-selected={isSelected}
                disabled={option.disabled}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (onChange) {
                    onChange({
                      target: { value: String(option.value) }
                    } as React.ChangeEvent<HTMLSelectElement>)
                  }
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1 text-left text-xs cursor-pointer transition-colors',
                  isSelected
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-popover-foreground hover:bg-muted hover:text-foreground',
                  option.disabled && 'pointer-events-none opacity-40'
                )}
              >
                <span>{option.label}</span>
                {isSelected && <span className="text-[10px] text-muted-foreground">✓</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  captionLayout = 'label',
  buttonVariant = 'ghost',
  locale,
  formatters,
  components,
  startMonth,
  endMonth,
  ...props
}: React.ComponentProps<typeof DayPicker> & {
  buttonVariant?: React.ComponentProps<typeof Button>['variant']
}): React.JSX.Element {
  const defaultClassNames = getDefaultClassNames()

  const resolvedStartMonth = React.useMemo(() => {
    if (startMonth) return startMonth
    if (captionLayout?.startsWith('dropdown')) {
      return new Date(new Date().getFullYear() - 10, 0, 1)
    }
    return undefined
  }, [startMonth, captionLayout])

  const resolvedEndMonth = React.useMemo(() => {
    if (endMonth) return endMonth
    if (captionLayout?.startsWith('dropdown')) {
      return new Date(new Date().getFullYear() + 1, 11, 31)
    }
    return undefined
  }, [endMonth, captionLayout])

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      // Session dates are `YYYY-MM-DD` (UTC) end-to-end, so the calendar must
      // pick in UTC too: a day clicked at local midnight would otherwise
      // become the previous day for timezones east of UTC once its UTC parts
      // are read back (day-cell ↔ string round-trip misalignment).
      timeZone="UTC"
      className={cn(
        'group/calendar bg-background p-2 [--cell-radius:var(--radius-md)] [--cell-size:--spacing(7)] in-data-[slot=card-content]:bg-transparent in-data-[slot=popover-content]:bg-transparent',
        String.raw`rtl:**:[.rdp-button\_next>svg]:rotate-180`,
        String.raw`rtl:**:[.rdp-button\_previous>svg]:rotate-180`,
        className
      )}
      captionLayout={captionLayout}
      locale={locale}
      startMonth={resolvedStartMonth}
      endMonth={resolvedEndMonth}
      formatters={{
        formatMonthDropdown: (date) => date.toLocaleString(locale?.code, { month: 'short' }),
        ...formatters
      }}
      classNames={{
        root: cn('w-fit', defaultClassNames.root),
        months: cn('relative flex flex-col gap-4 md:flex-row', defaultClassNames.months),
        month: cn('flex w-full flex-col gap-4', defaultClassNames.month),
        nav: cn(
          'absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1',
          defaultClassNames.nav
        ),
        button_previous: cn(
          buttonVariants({ variant: buttonVariant }),
          'size-(--cell-size) p-0 select-none aria-disabled:opacity-50',
          defaultClassNames.button_previous
        ),
        button_next: cn(
          buttonVariants({ variant: buttonVariant }),
          'size-(--cell-size) p-0 select-none aria-disabled:opacity-50',
          defaultClassNames.button_next
        ),
        month_caption: cn(
          'flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)',
          defaultClassNames.month_caption
        ),
        dropdowns: cn(
          'flex h-(--cell-size) w-full items-center justify-center gap-1.5 text-sm font-medium',
          defaultClassNames.dropdowns
        ),
        month_grid: cn('w-full border-collapse', defaultClassNames.month_grid),
        weekdays: cn('flex', defaultClassNames.weekdays),
        weekday: cn(
          'flex-1 rounded-(--cell-radius) text-[0.8rem] font-normal text-muted-foreground select-none',
          defaultClassNames.weekday
        ),
        week: cn('mt-2 flex w-full', defaultClassNames.week),
        week_number_header: cn('w-(--cell-size) select-none', defaultClassNames.week_number_header),
        week_number: cn(
          'text-[0.8rem] text-muted-foreground select-none',
          defaultClassNames.week_number
        ),
        day: cn(
          'group/day relative aspect-square h-full w-full rounded-(--cell-radius) p-0 text-center select-none [&:last-child[data-selected=true]_button]:rounded-r-(--cell-radius)',
          props.showWeekNumber
            ? '[&:nth-child(2)[data-selected=true]_button]:rounded-l-(--cell-radius)'
            : '[&:first-child[data-selected=true]_button]:rounded-l-(--cell-radius)',
          defaultClassNames.day
        ),
        range_start: cn(
          'relative isolate z-0 rounded-l-(--cell-radius) bg-muted after:absolute after:inset-y-0 after:right-0 after:w-4 after:bg-muted',
          defaultClassNames.range_start
        ),
        range_middle: cn('rounded-none', defaultClassNames.range_middle),
        range_end: cn(
          'relative isolate z-0 rounded-r-(--cell-radius) bg-muted after:absolute after:inset-y-0 after:left-0 after:w-4 after:bg-muted',
          defaultClassNames.range_end
        ),
        today: cn(
          'rounded-(--cell-radius) bg-muted text-foreground data-[selected=true]:rounded-none',
          defaultClassNames.today
        ),
        outside: cn(
          'text-muted-foreground aria-selected:text-muted-foreground',
          defaultClassNames.outside
        ),
        disabled: cn('text-muted-foreground opacity-50', defaultClassNames.disabled),
        hidden: cn('invisible', defaultClassNames.hidden),
        ...classNames
      }}
      components={{
        Root: ({ className, rootRef, ...props }) => {
          return <div data-slot="calendar" ref={rootRef} className={cn(className)} {...props} />
        },
        Chevron: ({ className, orientation, ...props }) => {
          if (orientation === 'left') {
            return <ChevronLeftIcon className={cn('size-4', className)} {...props} />
          }

          if (orientation === 'right') {
            return <ChevronRightIcon className={cn('size-4', className)} {...props} />
          }

          return <ChevronDownIcon className={cn('size-4', className)} {...props} />
        },
        DayButton: ({ ...props }) => <CalendarDayButton locale={locale} {...props} />,
        Dropdown: CalendarDropdown,
        WeekNumber: ({ children, ...props }) => {
          return (
            <td {...props}>
              <div className="flex size-(--cell-size) items-center justify-center text-center">
                {children}
              </div>
            </td>
          )
        },
        ...components
      }}
      {...props}
    />
  )
}

function CalendarDayButton({
  className,
  day,
  modifiers,
  locale,
  ...props
}: React.ComponentProps<typeof DayButton> & { locale?: Partial<Locale> }): React.JSX.Element {
  const defaultClassNames = getDefaultClassNames()

  const ref = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus()
  }, [modifiers.focused])

  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      data-day={day.date.toLocaleDateString(locale?.code, { timeZone: 'UTC' })}
      data-selected-single={
        modifiers.selected &&
        !modifiers.range_start &&
        !modifiers.range_end &&
        !modifiers.range_middle
      }
      data-range-start={modifiers.range_start}
      data-range-end={modifiers.range_end}
      data-range-middle={modifiers.range_middle}
      className={cn(
        'relative isolate z-10 flex aspect-square size-auto w-full min-w-(--cell-size) flex-col gap-1 border-0 leading-none font-normal group-data-[focused=true]/day:relative group-data-[focused=true]/day:z-10 group-data-[focused=true]/day:border-ring group-data-[focused=true]/day:ring-[3px] group-data-[focused=true]/day:ring-ring/50 data-[range-end=true]:rounded-(--cell-radius) data-[range-end=true]:rounded-r-(--cell-radius) data-[range-end=true]:bg-primary data-[range-end=true]:text-primary-foreground data-[range-middle=true]:rounded-none data-[range-middle=true]:bg-muted data-[range-middle=true]:text-foreground data-[range-start=true]:rounded-(--cell-radius) data-[range-start=true]:rounded-l-(--cell-radius) data-[range-start=true]:bg-primary data-[range-start=true]:text-primary-foreground data-[selected-single=true]:bg-primary data-[selected-single=true]:text-primary-foreground dark:hover:text-foreground [&>span]:text-xs [&>span]:opacity-70',
        defaultClassNames.day,
        className
      )}
      {...props}
    />
  )
}

export { Calendar, CalendarDayButton }
