import type { ReactNode } from 'react'

// admin 独立 layout：不挂主站 Header/Footer/nav，纯净后台
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-[#03060b] text-white">{children}</div>
}
