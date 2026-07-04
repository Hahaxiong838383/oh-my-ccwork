'use client'

import { useEffect } from 'react'

export function SiteMotion() {
  useEffect(() => {
    const root = document.documentElement
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let frame = 0
    let pointerX = window.innerWidth * 0.5
    let pointerY = window.innerHeight * 0.5

    const writePointer = () => {
      root.style.setProperty('--cursor-x', `${pointerX}px`)
      root.style.setProperty('--cursor-y', `${pointerY}px`)
      frame = 0
    }

    const onPointerMove = (event: PointerEvent) => {
      if (reduceMotion) return
      pointerX = event.clientX
      pointerY = event.clientY
      if (!frame) frame = window.requestAnimationFrame(writePointer)
    }

    const onScroll = () => {
      const scrollable = Math.max(document.body.scrollHeight - window.innerHeight, 1)
      const progress = Math.min(window.scrollY / scrollable, 1)
      root.style.setProperty('--scroll-progress', String(progress))
      root.style.setProperty('--scroll-depth', `${Math.min(window.scrollY / 900, 1)}`)
    }

    root.dataset.motion = reduceMotion ? 'reduced' : 'ready'
    writePointer()
    onScroll()

    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      delete root.dataset.motion
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [])

  return (
    <>
      <div className="site-scroll-progress" aria-hidden="true" />
      <div className="site-ambient-field" aria-hidden="true" />
    </>
  )
}
