import Foundation

/// Give the player's own fit calculation a width-sized layout area. Its native
/// scale state remains authoritative; do not override its transform or cursor.
enum ProtoPieWidthFit {
    static func expression(enabled: Bool, verticalPosition: Double = 0, expectedURL: URL) -> String {
        let path = String(data: try! JSONSerialization.data(withJSONObject: [expectedURL.path]), encoding: .utf8)!
        let position = verticalPosition.isFinite ? min(1, max(-1, verticalPosition)) : 0
        return #"""
        (() => {
          const key = '__nioWarpWidthFitV2';
          window.__nioWarpWidthFitV1?.dispose(); delete window.__nioWarpWidthFitV1;
          const expectedPath=\#(path)[0];
          const matchesPage=()=>location.protocol==='https:' && location.hostname==='cloud.protopie.io' && location.pathname===expectedPath;
          if (!\#(enabled ? "true" : "false")) {
            window[key]?.dispose(); delete window[key]; return {ready:true};
          }
          if (!matchesPage()) {window[key]?.dispose();delete window[key];return {ready:false};}
          if (window[key] && window[key].path!==expectedPath) {window[key].dispose();delete window[key];}
          if (!window[key]) {
            let root, host, main, original, frame = 0, disposed = false, notifying = false;
            const properties = ['width','height','flex','top'];
            const restore = () => {
              if (host && original) for (const name of properties) {
                const [value, priority] = original[name];
                if (value) host.style.setProperty(name,value,priority); else host.style.removeProperty(name);
              }
            };
            const status = () => {
              if (!root?.isConnected || !main?.isConnected) return {ready:false};
              const b=root.getBoundingClientRect(), m=main.getBoundingClientRect();
              const sx=b.width/root.offsetWidth, sy=b.height/root.offsetHeight;
              const shift=window[key].position*Math.max(0,b.height-m.height)/2;
              return {ready: b.width>0 && Math.abs(b.width-m.width)<2 && Math.abs(b.x-m.x)<2 &&
                Math.abs((b.y+b.height/2)-(m.y+m.height/2+shift))<2 && Math.abs(sx-sy)<0.001,
                width:b.width,height:b.height,viewportWidth:m.width,scale:sx};
            };
            const resize = new ResizeObserver(() => schedule());
            const apply = () => {
              frame=0; if (disposed) return {ready:false};
              if (!matchesPage()) {window[key]?.dispose();delete window[key];return {ready:false};}
              const next=document.getElementById('webplayer-root');
              if (next !== root) {
                restore(); resize.disconnect(); root=next; host=root?.parentElement?.parentElement; main=host?.parentElement;
                original=undefined;
                if (!root || main?.tagName!=='MAIN' || !host.contains(root)) {root=undefined;return {ready:false};}
                original=Object.fromEntries(properties.map(n=>[n,[host.style.getPropertyValue(n),host.style.getPropertyPriority(n)]]));
                resize.observe(root); resize.observe(main);
              }
              if (!root || !root.offsetWidth || !root.offsetHeight || !main.clientWidth || !main.clientHeight) return {ready:false};
              const width=main.clientWidth, height=Math.max(main.clientHeight,width*root.offsetHeight/root.offsetWidth);
              const top=(main.clientHeight-height)/2+window[key].position*(height-main.clientHeight)/2;
              const values={width:width+'px',height:height+'px',flex:'none',top:top+'px'};
              let changed=false;
              for (const name of properties) if (host.style.getPropertyValue(name)!==values[name]) {
                host.style.setProperty(name,values[name]); changed=true;
              }
              // ProtoPie updates its scale on window.resize, not ResizeObserver.
              if (changed || !status().ready) {
                notifying=true; window.dispatchEvent(new Event('resize')); notifying=false;
              }
              return status();
            };
            const schedule = () => { if (!disposed && !frame) frame=requestAnimationFrame(apply); };
            const mutation=new MutationObserver(() => {if (document.getElementById('webplayer-root')!==root) schedule();});
            mutation.observe(document.documentElement,{childList:true,subtree:true});
            const onResize=()=>{if(!notifying) schedule();};
            window.addEventListener('resize',onResize);
            window[key]={path:expectedPath,position:0,ensure:apply,dispose:()=>{disposed=true;cancelAnimationFrame(frame);resize.disconnect();mutation.disconnect();window.removeEventListener('resize',onResize);restore();window.dispatchEvent(new Event('resize'));}};
          }
          window[key].position=\#(position);
          return window[key].ensure();
        })()
        """#
    }
}
