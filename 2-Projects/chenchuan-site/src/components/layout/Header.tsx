'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/cn'
import { Menu, X } from 'lucide-react'

const navItems = [
  { label: '首页', href: '/' },
  { label: '关于', href: '/about' },
  { label: '作品', href: '/work' },
  { label: '前沿资讯雷达', href: '/radar' },
  { label: '视频', href: '/videos' },
  { label: '思考', href: '/writing' },
  { label: '专利', href: '/patents' },
  { label: '联系', href: '/contact' },
]

export function Header() {
  const [scrolled, setScrolled] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const pathname = usePathname()
  const isAdminRoute = pathname.startsWith('/admin')

  useEffect(() => {
    if (isAdminRoute) return
    const onScroll = () => setScrolled(window.scrollY > 60)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [isAdminRoute])

  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  // 后台有独立管理导航。移除固定站点 Header，避免透明导航层覆盖后台按钮热区。
  if (isAdminRoute) return null

  return (
    <header
      className={cn(
        'site-header fixed left-0 right-0 top-0 z-50 transition-all duration-300',
        scrolled
          ? 'is-scrolled border-b border-border bg-bg-primary/80 backdrop-blur-xl'
          : 'bg-transparent',
      )}
    >
      <nav className="mx-auto flex max-w-content items-center justify-between px-6 py-4 md:px-8">
        <Link href="/" className="nav-brand font-semibold tracking-tight text-text-primary">
          陈川
        </Link>

        <ul className="hidden items-center gap-8 md:flex">
          {navItems.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                prefetch={item.href === '/radar' ? false : undefined}
                data-active={pathname === item.href}
                className={cn(
                  'nav-link relative text-sm transition-colors duration-200',
                  pathname === item.href
                    ? 'text-text-primary'
                    : 'text-text-secondary hover:text-text-primary',
                )}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>

        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          className="nav-icon-button text-text-secondary md:hidden"
          aria-label={mobileOpen ? '关闭菜单' : '打开菜单'}
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      </nav>

      {mobileOpen && (
        <div className="mobile-sheet border-t border-border bg-bg-primary/95 backdrop-blur-xl md:hidden">
          <ul className="mx-auto max-w-content px-6 py-4">
            {navItems.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  prefetch={item.href === '/radar' ? false : undefined}
                  className={cn(
                    'block py-2.5 text-sm transition-colors',
                    pathname === item.href
                      ? 'text-text-primary'
                      : 'text-text-secondary',
                  )}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </header>
  )
}
