'use client'

import { useRef } from 'react'

interface FigureProps {
  name: string
  caption: string
  width: number
  height: number
  preview?: boolean
}

export function RouterFigure({ name, caption, width, height, preview }: FigureProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const enlarged = useRef<HTMLImageElement>(null)
  const image = '/task-router/' + name
  return (
    <figure>
      <a
        className="rr-zoom"
        href={image + '.webp'}
        aria-label={'放大：' + caption}
        onClick={event => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
          if (!dialog.current || !enlarged.current) return
          event.preventDefault()
          enlarged.current.src = image + '.webp'
          dialog.current.showModal()
        }}
      >
        <img src={image + (preview ? '-preview.webp' : '.webp')} alt={caption} width={width} height={height} loading="lazy" decoding="async" />
      </a>
      <figcaption>{caption}</figcaption>
      <dialog ref={dialog} className="rr-dialog" aria-label={caption}>
        <button type="button" onClick={() => dialog.current?.close()}>关闭大图</button>
        <div><img ref={enlarged} alt={caption} width={width} height={height} /></div>
      </dialog>
    </figure>
  )
}
