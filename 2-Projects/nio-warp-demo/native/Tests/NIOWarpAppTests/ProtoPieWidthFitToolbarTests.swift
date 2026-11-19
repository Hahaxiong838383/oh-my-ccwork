import Foundation
import JavaScriptCore
import XCTest
@testable import NIOWarpApp

final class ProtoPieWidthFitToolbarTests: XCTestCase {
    private let url = URL(string: "https://cloud.protopie.io/p/toolbar-regression")!

    /// The fixture implements ordinary relative positioning and native aspect-fit
    /// layout, not the width-fit patch's flowTop/crop calculation. Production JS
    /// must compensate the padding through the CSS properties it actually writes.
    private func context(designHeight: Double = 1400, originalStyle: Bool = false) throws -> JSContext {
        let context = try XCTUnwrap(JSContext())
        context.evaluateScript(#"""
        var window=globalThis;
        var location={protocol:'https:',hostname:'cloud.protopie.io',pathname:'/p/toolbar-regression'};
        var resizeEvents=0, mainPadding=0, scale=1, nextFrame=1;
        var frames=new Map(), mutations=[], resizeObservers=[], listeners=[];
        class Style {
          constructor(){this.values={};this.priorities={};}
          getPropertyValue(n){return this.values[n]||'';}
          getPropertyPriority(n){return this.priorities[n]||'';}
          setProperty(n,v,p=''){this.values[n]=String(v);this.priorities[n]=p;}
          removeProperty(n){delete this.values[n];delete this.priorities[n];}
        }
        function rect(x,y,width,height){return {x,y,top:y,left:x,width,height,right:x+width,bottom:y+height};}
        var main={tagName:'MAIN',isConnected:true,clientWidth:7680,clientHeight:2800,
          getBoundingClientRect(){return rect(17,31,this.clientWidth,this.clientHeight);}};
        var host={parentElement:main,isConnected:true,style:new Style(),contains(v){return v===root;},
          getBoundingClientRect(){
            const m=main.getBoundingClientRect();
            return rect(m.x,m.y+mainPadding+(parseFloat(this.style.getPropertyValue('top'))||0),
              parseFloat(this.style.getPropertyValue('width'))||main.clientWidth,
              parseFloat(this.style.getPropertyValue('height'))||main.clientHeight);
          }};
        var wrapper={parentElement:host};
        var root={parentElement:wrapper,isConnected:true,offsetWidth:3840,offsetHeight:\#(designHeight),
          getBoundingClientRect(){
            const h=host.getBoundingClientRect(),w=this.offsetWidth*scale,v=this.offsetHeight*scale;
            return rect(h.x+(h.width-w)/2,h.y+(h.height-v)/2,w,v);
          }};
        var document={documentElement:{},getElementById(id){return id==='webplayer-root'?root:null;}};
        function nativeFit(){const h=host.getBoundingClientRect();scale=Math.min(h.width/root.offsetWidth,h.height/root.offsetHeight);}
        function getComputedStyle(v){return {top:v.style.getPropertyValue('top')||'auto'};}
        class Event {constructor(type){this.type=type;}}
        window.addEventListener=(type,fn)=>{if(type==='resize')listeners.push(fn);};
        window.removeEventListener=(type,fn)=>{listeners=listeners.filter(v=>v!==fn);};
        window.dispatchEvent=event=>{if(event.type==='resize'){resizeEvents++;nativeFit();[...listeners].forEach(fn=>fn(event));}};
        class ResizeObserver {
          constructor(fn){this.fn=fn;this.targets=[];resizeObservers.push(this);}
          observe(target){this.targets.push(target);}
          disconnect(){this.targets=[];}
        }
        class MutationObserver {
          constructor(fn){this.fn=fn;this.active=false;mutations.push(this);}
          observe(target,options){this.active=true;this.options=options;}
          disconnect(){this.active=false;}
        }
        function requestAnimationFrame(fn){const id=nextFrame++;frames.set(id,fn);return id;}
        function cancelAnimationFrame(id){frames.delete(id);}
        function flushFrames(){for(let i=0;frames.size&&i<20;i++){const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn(0));}if(frames.size)throw Error('animation frame loop');}
        function toolbar(padding,attributeName='class'){
          mainPadding=padding;
          mutations.filter(v=>v.active&&v.options.attributes&&v.options.subtree&&v.options.attributeFilter.includes(attributeName))
            .forEach(v=>v.fn([{type:'attributes',target:main,attributeName}]));
        }
        function layout(){const r=root.getBoundingClientRect(),m=main.getBoundingClientRect();return {
          x:r.x-m.x,y:r.y-m.y,width:r.width,height:r.height,scale,
          hostTop:parseFloat(host.style.getPropertyValue('top'))||0,frames:frames.size,resizeEvents};}
        if(\#(originalStyle ? "true" : "false")) {
          host.style.setProperty('width','321px','important');
          host.style.setProperty('height','456px');
          host.style.setProperty('flex','2 1 auto','important');
          host.style.setProperty('top','13px','important');
        }
        host.style.setProperty('opacity','0.7','important');
        nativeFit();
        """#)
        XCTAssertNil(context.exception)
        return context
    }

    @discardableResult private func apply(_ context: JSContext, enabled: Bool = true, position: Double = 0) throws -> [AnyHashable: Any] {
        context.exception = nil
        let value = context.evaluateScript(ProtoPieWidthFit.expression(enabled: enabled, verticalPosition: position, expectedURL: url))
        XCTAssertNil(context.exception)
        return try XCTUnwrap(value?.toDictionary())
    }

    private func run(_ script: String, in context: JSContext) {
        context.exception = nil
        context.evaluateScript(script)
        XCTAssertNil(context.exception)
    }

    private func layout(_ context: JSContext) throws -> [String: Double] {
        let value = try XCTUnwrap(context.evaluateScript("layout()")?.toDictionary() as? [String: NSNumber])
        XCTAssertNil(context.exception)
        return value.mapValues(\.doubleValue)
    }

    func testToolbarPaddingChangesKeepContentPositionAndNativeScaleStable() throws {
        let context = try context()
        XCTAssertEqual(try apply(context)["ready"] as? Bool, true)
        let initial = try layout(context)
        for attribute in ["class", "style"] {
            for padding in [56, 0] {
                run("toolbar(\(padding),'\(attribute)');", in: context)
                XCTAssertEqual(try layout(context)["frames"], 1)
                run("flushFrames();", in: context)
                let current = try layout(context)
                for property in ["x", "y", "width", "height", "scale"] {
                    XCTAssertEqual(current[property], initial[property], property)
                }
                XCTAssertEqual(current["hostTop"], Double(-padding))
            }
        }
        XCTAssertEqual(initial["width"], 7680)
        XCTAssertEqual(initial["height"], 2800)
        XCTAssertEqual(initial["scale"], 2)
    }

    func testEqualViewportHeightKeepsZeroCropTravelForLegacyPositionValues() throws {
        let context = try context()
        for padding in [0, 56] {
            run("toolbar(\(padding));flushFrames();", in: context)
            for position in [-1.0, -0.954431190851735, 0, 0.75, 1] {
                XCTAssertEqual(try apply(context, position: position)["ready"] as? Bool, true)
                let current = try layout(context)
                XCTAssertEqual(current["y"], 0)
                XCTAssertEqual(current["height"], 2800)
                XCTAssertEqual(current["scale"], 2)
                XCTAssertEqual(current["hostTop"], Double(-padding))
            }
        }
    }

    func testOverflowPreservesOriginalVerticalCropFormulaAcrossToolbarStates() throws {
        let context = try context(designHeight: 1800)
        for padding in [0, 56, 0] {
            run("toolbar(\(padding));flushFrames();", in: context)
            for position in [-1.0, -0.4, 0, 0.6, 1] {
                XCTAssertEqual(try apply(context, position: position)["ready"] as? Bool, true)
                let current = try layout(context)
                XCTAssertEqual(try XCTUnwrap(current["y"]), -400 + position * 400, accuracy: 0.000001)
                XCTAssertEqual(current["width"], 7680)
                XCTAssertEqual(current["height"], 3600)
                XCTAssertEqual(current["scale"], 2)
                XCTAssertEqual(try XCTUnwrap(current["hostTop"]), -400 + position * 400 - Double(padding), accuracy: 0.000001)
            }
        }
    }

    func testRepeatedEnsureDoesNotAccumulateTopCompensationOrResizeEvents() throws {
        let context = try context(designHeight: 1800)
        run("toolbar(56);", in: context)
        _ = try apply(context, position: -0.4)
        let initial = try layout(context)
        for _ in 0..<25 {
            XCTAssertEqual(try apply(context, position: -0.4)["ready"] as? Bool, true)
            XCTAssertEqual(try layout(context), initial)
        }
    }

    func testOldV2RevisionIsDisposedBeforeInstallingRevisionThree() throws {
        let context = try context()
        run("var oldDisposed=0;window.__nioWarpWidthFitV2={revision:2,path:location.pathname,dispose(){oldDisposed++;}};", in: context)
        XCTAssertEqual(try apply(context)["ready"] as? Bool, true)
        XCTAssertEqual(context.evaluateScript("oldDisposed")?.toInt32(), 1)
        XCTAssertEqual(context.evaluateScript("window.__nioWarpWidthFitV2.revision")?.toInt32(), 3)
        _ = try apply(context)
        XCTAssertEqual(context.evaluateScript("oldDisposed")?.toInt32(), 1)
    }

    func testDisableRestoresOriginalHostStylesAndPrioritiesAndDisconnectsObservers() throws {
        let context = try context(originalStyle: true)
        _ = try apply(context)
        run("toolbar(56);flushFrames();", in: context)
        XCTAssertEqual(try apply(context, enabled: false)["ready"] as? Bool, true)
        for (name, value, priority) in [("width", "321px", "important"), ("height", "456px", ""),
                                       ("flex", "2 1 auto", "important"), ("top", "13px", "important"),
                                       ("opacity", "0.7", "important")] {
            XCTAssertEqual(context.evaluateScript("host.style.getPropertyValue('\(name)')")?.toString(), value)
            XCTAssertEqual(context.evaluateScript("host.style.getPropertyPriority('\(name)')")?.toString(), priority)
        }
        XCTAssertEqual(context.evaluateScript("typeof window.__nioWarpWidthFitV2")?.toString(), "undefined")
        XCTAssertEqual(context.evaluateScript("mutations.filter(v=>v.active).length")?.toInt32(), 0)
        XCTAssertEqual(context.evaluateScript("resizeObservers.flatMap(v=>v.targets).length")?.toInt32(), 0)
        XCTAssertEqual(context.evaluateScript("listeners.length")?.toInt32(), 0)
        run("toolbar(0);flushFrames();", in: context)
        XCTAssertEqual(context.evaluateScript("host.style.getPropertyValue('top')")?.toString(), "13px")
    }

    func testDisableRemovesPreviouslyAbsentHostProperties() throws {
        let context = try context()
        _ = try apply(context)
        _ = try apply(context, enabled: false)
        for name in ["width", "height", "flex", "top"] {
            XCTAssertEqual(context.evaluateScript("host.style.getPropertyValue('\(name)')")?.toString(), "")
            XCTAssertEqual(context.evaluateScript("host.style.getPropertyPriority('\(name)')")?.toString(), "")
        }
        XCTAssertEqual(context.evaluateScript("host.style.getPropertyValue('opacity')")?.toString(), "0.7")
    }
}
