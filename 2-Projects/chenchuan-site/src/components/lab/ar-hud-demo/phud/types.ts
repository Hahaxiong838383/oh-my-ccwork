export interface SpeedData {
  value: number
  unit: string
  gear: string
  status: string
}

export interface EnergyData {
  percent: number
  range: number
  tempC: number
  time: string
}

export interface NavData {
  distance: string
  instruction: string
  road: string
}

export interface EtaData {
  distance: string
  arrival: string
}

export interface MediaData {
  title: string
  artist: string
  progress: string
  duration: string
}

export interface PreviewData {
  current: string
  total: string
  tempC: number
}

export interface PhudData {
  speed: SpeedData
  energy: EnergyData
  nav: NavData
  eta: EtaData
  media: MediaData
  preview: PreviewData
}

export interface PoiItem {
  id: string
  icon: 'Building2' | 'Waves'
  label: string
  distance: string
  x: number
  y: number
  size: 'sm' | 'md'
  // POI 接管 NavCard + EtaCard 用（Batch 3）
  minutesAway: string      // 如 "12 min"
  arrival: string          // 如 "7:57 PM"
  nextManeuver: string     // 如 "Turn right"
  roadName: string         // 如 "Seaside Blvd"
  nextDistance: string     // 如 "1.2 km"
}

export interface HudData {
  phud: PhudData
  poi: PoiItem[]
}

export const MONO_FONT =
  'JetBrains Mono, Geist Mono, ui-monospace, SFMono-Regular, monospace'
