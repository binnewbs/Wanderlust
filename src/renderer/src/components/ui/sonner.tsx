import { useEffect, useState } from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon
} from 'lucide-react'

/**
 * The app pins dark mode via the `dark` class on <html> (there is no theme
 * toggle yet); the Toaster follows that same class so it keeps in sync if a
 * light/dark switch is ever added.
 */
function useDocumentTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
      ? 'dark'
      : 'light'
  )
  useEffect(() => {
    const el = document.documentElement
    const update = (): void => setTheme(el.classList.contains('dark') ? 'dark' : 'light')
    update()
    const mo = new MutationObserver(update)
    mo.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])
  return theme
}

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useDocumentTheme()

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)'
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: 'cn-toast'
        }
      }}
      {...props}
    />
  )
}

export { Toaster }
