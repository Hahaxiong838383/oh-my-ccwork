/** Retrieval preferences only. The configured allowlist remains authoritative
 * for both accepted search evidence and Fetch; a hint grants no new domain. */
export function p2AcceptsSource(query: string, url: string, title: string): boolean {
  const u = new URL(url);
  // A publisher-hosted discussion is still user content, not a shipped feature.
  if(u.hostname==='feedback.minecraft.net'&&/\/(?:community|profiles)\//.test(u.pathname))return false;
  // The upstream has returned these derivative rulebooks for ordinary
  // badminton. Do not silently substitute a different sport's court rules.
  if(/羽毛球|badminton/i.test(query)){
    for(const facet of [/户外羽毛球|airbadminton/i,/轮椅羽毛球|wheelchair/i,/毽球|柔力球|匹克球/]){
      if(facet.test(title+' '+u.pathname)&&!facet.test(query))return false;
    }
  }
  return true;
}

export function p2SourceScope(query: string, allowed: string[]): string {
  const domains = [...new Set(allowed.filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))];
  let preferred: string[] = [];
  if (/国家博物馆|国博/.test(query)) preferred = ['chnmuseum.cn'];
  else if (/故宫/.test(query)) preferred = ['dpm.org.cn'];
  else if (/我的世界|minecraft/i.test(query)) {
    preferred = /中国版|网易版/.test(query) ? ['mc.163.com']
      : /基岩版|java|国际版/i.test(query) ? ['minecraft.net']
      : ['minecraft.net','mc.163.com'];
    if(!/官网|官方|公告|更新|版本/.test(query))preferred.push('minecraft.wiki');
  } else if (/宝可梦|pokemon|pokémon/i.test(query)) preferred = ['pokemon.cn','pokemon.com.cn'];
  else if (/羽毛球|羽联|\bbwf\b/i.test(query)) {
    preferred = ['bwf.sport','bwfbadminton.com','olympics.com'];
    if(!/官网|官方|羽联|\bbwf\b/i.test(query))preferred.push('kepuchina.cn','baike.baidu.com');
  }
  else if (/\bnba\b|库里|勇士队/i.test(query)) preferred = ['nba.com'];
  else if (/谁唱|演唱|歌手|歌曲|这首歌|主题曲|片尾曲/.test(query)) preferred = ['y.qq.com','baike.baidu.com','zh.wikipedia.org'];
  else if (/新闻|消息|进展/.test(query)) preferred = ['cctv.com','xinhuanet.com','people.com.cn','gov.cn'];
  else preferred = ['kepuchina.cn','cas.cn','baike.baidu.com','zh.wikipedia.org'];
  const selected = preferred.filter(d => domains.includes(d));
  const scope = selected.length ? selected : domains;
  // Keep complete clauses in relevance order. Overflow must not remove every
  // hint and leave all ten results outside the configured evidence allowlist.
  let scoped=query,first=true;
  for(const d of scope){const next=scoped+(first?' site:':' OR site:')+d;if([...next].length<=128){scoped=next;first=false;}}
  return scoped;
}
