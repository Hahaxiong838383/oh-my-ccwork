import { Hero } from '@/components/home/Hero'
import { Stats } from '@/components/home/Stats'
import { MediaCoverage } from '@/components/home/MediaCoverage'
import { ProjectGrid } from '@/components/home/ProjectGrid'
import { AIWorkflow } from '@/components/home/AIWorkflow'
import { AINativeDay } from '@/components/home/AINativeDay'
import { VideoSection } from '@/components/home/VideoSection'
import { KeyWins } from '@/components/home/KeyWins'
import { Timeline } from '@/components/home/Timeline'
import { PatentPreview } from '@/components/home/PatentPreview'
import { ContactCTA } from '@/components/home/ContactCTA'
import { getProjects, getPatents, getTimeline, getVideos } from '@/lib/data'
import { getRadarTicker } from '@/lib/radar'

export const revalidate = 60

export default async function HomePage() {
  const [projects, patents, timeline, videos, ticker] = await Promise.all([
    getProjects(),
    getPatents(),
    getTimeline(),
    getVideos(),
    getRadarTicker(),
  ])

  return (
    <>
      <Hero
        patentCount={patents.length}
        tickerItems={ticker.map((it) => ({ title: it.title, source: it.source, url: it.url }))}
      />
      <Stats patentCount={patents.length} />
      <MediaCoverage />
      <ProjectGrid projects={projects} />
      <AIWorkflow />
      <AINativeDay />
      <VideoSection videos={videos} />
      <KeyWins />
      <Timeline timeline={timeline} />
      <PatentPreview patents={patents} />
      <ContactCTA />
    </>
  )
}
