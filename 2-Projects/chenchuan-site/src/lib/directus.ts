import { createDirectus, rest, readItems, readSingleton } from '@directus/sdk'

// Directus collection types
export interface DProfile {
  id: number
  name: string
  name_en: string
  title: string
  tagline: string
  bio: string
  bio_extended: string
  phone: string
  email: string
  location: string
  linkedin: string
  github: string
  wechat: string
}

export interface DProject {
  id: number
  sort: number
  status: string
  slug: string
  title: string
  subtitle: string
  description: string
  full_description: string
  tags: string[]
  year: string
  company: string
  role: string
  highlights: string[]
  wins: string[]
  color: string
  featured: boolean
}

export interface DPatent {
  id: number
  sort: number
  title: string
  number: string
  status: string
  status_label: string
}

export interface DTimeline {
  id: number
  sort: number
  period: string
  company: string
  role: string
  description: string
  tags: string[]
}

export interface DArticle {
  id: number
  status: string
  slug: string
  title: string
  excerpt: string
  date: string
  tags: string[]
  content: string
}

export interface DVideo {
  id: number
  sort: number
  title: string
  description: string
  url: string
  thumbnail: string | null
  duration: string
  tags: string[]
}

export interface DirectusSchema {
  profile: DProfile
  projects: DProject[]
  patents: DPatent[]
  timeline: DTimeline[]
  articles: DArticle[]
  videos: DVideo[]
}

const DIRECTUS_URL = process.env.DIRECTUS_URL || 'http://localhost:8055'

export const directus = createDirectus<DirectusSchema>(DIRECTUS_URL).with(rest())

export { readItems, readSingleton }
