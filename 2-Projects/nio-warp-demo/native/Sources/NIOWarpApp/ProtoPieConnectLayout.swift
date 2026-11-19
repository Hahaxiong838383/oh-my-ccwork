import Foundation

/// Connect 2.13 uses its own Stage/D3 host, separate from the Cloud web player.
/// Readiness never changes its transforms or cursor. Width fill needs a safe
/// native Stage API and remains explicitly unsupported by this adapter.
enum ProtoPieConnectLayout {
    static func expression(enabled: Bool, verticalPosition: Double = 0, expectedURL: URL) -> String {
        guard var components = URLComponents(url: expectedURL, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = components.host, !host.isEmpty, components.user == nil, components.password == nil,
              components.percentEncodedPath == "/pie" else { return "({ready:false,issue:'invalid-source'})" }
        let ids = (components.queryItems ?? []).filter { $0.name == "pieid" }
        guard ids.count == 1, let value = ids[0].value, !value.isEmpty,
              value.utf8.allSatisfy({ (48...57).contains($0) }), let number = Int(value), number > 0 else {
            return "({ready:false,issue:'invalid-source'})"
        }
        let path = components.percentEncodedPath
        components.scheme = scheme; components.host = host.lowercased()
        if components.port == (scheme == "https" ? 443 : 80) { components.port = nil }
        components.path = ""; components.query = nil; components.fragment = nil
        guard let origin = components.url?.absoluteString else { return "({ready:false,issue:'invalid-source'})" }
        let arguments = String(decoding: try! JSONSerialization.data(withJSONObject: [origin, path, String(number)]), as: UTF8.self)
        return #"""
        (() => {
          const key='__nioWarpConnectWidthFitV1';
          const expected=\#(arguments);
          const stop=()=>{window[key]?.dispose();delete window[key];};
          const matchesPage=()=>{
            try {
              const ids=new URLSearchParams(location.search).getAll('pieid');
              return location.origin===expected[0] && location.pathname===expected[1] && ids.length===1 &&
                /^[0-9]+$/.test(ids[0]) && ids[0].replace(/^0+/,'')===expected[2];
            } catch {return false;}
          };
          const visible=e=>{
            if(!e?.isConnected)return false;
            const r=e.getBoundingClientRect(),s=getComputedStyle(e);
            return [r.x,r.y,r.width,r.height].every(Number.isFinite) && r.width>0 && r.height>0 &&
              s.visibility!=='hidden' && s.display!=='none' && Number(s.opacity)!==0;
          };
          // Reclaim an adapter left by an earlier candidate. The native Stage
          // branch owns no styles, observers, listeners or animation frames.
          stop();
          if(!matchesPage())return {ready:false,issue:'page-mismatch'};
          const root=document.getElementById('pie-screen');
          if(!['interactive','complete'].includes(document.readyState) ||
            ![innerWidth,innerHeight,devicePixelRatio].every(n=>Number.isFinite(n)&&n>0) || !root)
            return {ready:false,issue:'player-not-ready'};
          const layer=root.parentElement,viewport=layer?.parentElement,zoomPane=viewport?.parentElement,stage=zoomPane?.parentElement;
          const has=(e,name)=>e?.isConnected&&e.classList.contains(name);
          const direct=(e,name)=>[...e.children].filter(child=>has(child,name));
          if(!has(layer,'layer')||!has(viewport,'viewport')||!has(zoomPane,'zoom-pane')||!has(stage,'stage') ||
            document.querySelectorAll('#pie-screen').length!==1 || direct(viewport,'layer').length!==1 ||
            direct(zoomPane,'viewport').length!==1 || direct(stage,'zoom-pane').length!==1)
            return {ready:false,issue:'unsupported-layout'};
          // A .viewport can have a zero-size rect because its children are
          // absolutely positioned. Rnd also adds resize handles beside the Pie.
          if(![stage,zoomPane,layer,root].every(visible) ||
            ![root.offsetWidth,root.offsetHeight].every(n=>Number.isFinite(n)&&n>0) || ![...root.children].some(visible))
            return {ready:false,issue:'player-not-ready'};
          const coversWindow=e=>{const r=e.getBoundingClientRect();return Math.abs(r.x)<2&&Math.abs(r.y)<2&&
            Math.abs(r.width-innerWidth)<2&&Math.abs(r.height-innerHeight)<2;};
          if(!coversWindow(stage)||!coversWindow(zoomPane))return {ready:false,issue:'unsupported-layout'};
          const z=zoomPane.__zoom;
          const m=viewport.style.getPropertyValue('transform').match(/^translate\(\s*([^,]+)px,\s*([^\)]+)px\)\s*scale\(\s*([^\)]+)\s*\)$/);
          if(!z||![z.x,z.y,z.k].every(Number.isFinite)||z.k<=0||!m ||
            ![z.x,z.y,z.k].every((value,index)=>Math.abs(Number(m[index+1])-value)<0.00001*(1+Math.abs(value))))
            return {ready:false,issue:'player-not-ready'};
          const r=root.getBoundingClientRect(),sx=r.width/root.offsetWidth,sy=r.height/root.offsetHeight;
          if(!Number.isFinite(sx)||sx<=0||Math.abs(sx-sy)>=0.001)return {ready:false,issue:'player-not-ready'};
          const status={ready:true,layout:'connect-stage-2.13',width:r.width,height:r.height,
            viewportWidth:innerWidth,viewportHeight:innerHeight,scale:sx};
          return \#(enabled ? "true" : "false")?{...status,ready:false,nativeReady:true,issue:'width-fit-unavailable'}:status;
        })()
        """#
    }
}
