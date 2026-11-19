import AppKit
import JavaScriptCore
import XCTest
@testable import NIOWarpApp

@MainActor final class ProtoPieConnectRuntimeTests: XCTestCase {
    func testV2DraftDoesNotOverwriteV1Configuration() throws {
        let suite = "nio-connect-migration-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var legacy = ProtoPieConfiguration()
        legacy.cloudURL = "https://cloud.protopie.io/p/legacy"
        let old = try JSONEncoder().encode(legacy)
        defaults.set(old, forKey: "nioWarpProtoPie.configuration.v1")
        let coordinator = ProtoPieCoordinator(defaults: defaults)
        XCTAssertEqual(coordinator.saved, legacy)
        coordinator.draft.source = .connect
        coordinator.draft.connectURL = "http://localhost:9981/pie?pieid=1"
        XCTAssertTrue(coordinator.saveConfiguration())
        XCTAssertEqual(defaults.data(forKey: "nioWarpProtoPie.configuration.v1"), old)
        XCTAssertNotNil(defaults.data(forKey: "nioWarpProtoPie.configuration.v2"))
        XCTAssertNil(defaults.object(forKey: "nioWarpProtoPie.draft.v1"))
    }

    func testConnectReadinessRequiresBoundPrototypeAndRenderedContent() throws {
        let context = try XCTUnwrap(JSContext())
        context.evaluateScript(#"""
        var location={origin:'http://localhost:9981',hostname:'localhost',pathname:'/pie',search:'?pieid=1',href:'http://localhost:9981/pie?pieid=1'};
        var URLSearchParams=function(s){this.getAll=n=>n==='pieid'?[s.split('=')[1]]:[];};
        var innerWidth=1920,innerHeight=1080;
        var getComputedStyle=e=>({visibility:'visible'});
        var layer={getBoundingClientRect:()=>({width:500,height:200})};
        var root={getBoundingClientRect:()=>({width:1920,height:1080}),querySelectorAll:()=>[layer]};
        var mounted=true,rendered=true;
        var document={readyState:'complete',title:'',body:{innerText:''},
          querySelector:s=>s==='#pie-screen'&&mounted?root:null,
          querySelectorAll:s=>s==='input[type=password]'?[]:[]};
        root.querySelectorAll=()=>rendered?[layer]:[];
        """#)
        let expression = ProtoPieSystemDriver.connectReadinessExpression(
            expectedURL: URL(string: "http://localhost:9981/pie?pieid=1")!, marker: "NIO Warp Connect Preview · test")
        func ready() throws -> Bool {
            let result = try XCTUnwrap(context.evaluateScript(expression)?.toDictionary())
            XCTAssertNil(context.exception)
            return result["ready"] as? Bool == true
        }
        XCTAssertTrue(try ready())
        context.evaluateScript("location.search='?pieid=2';")
        XCTAssertFalse(try ready())
        context.evaluateScript("location.search='?pieid=1';rendered=false;")
        XCTAssertFalse(try ready())
        context.evaluateScript("rendered=true;location.origin='http://localhost:9982';")
        XCTAssertFalse(try ready())
    }

    func testConnectReadinessComparesLargePieIDsWithoutNumericRounding() throws {
        let context = try readinessContext()
        let expected = URL(string: "http://localhost:9981/pie?pieid=9007199254740992")!
        context.evaluateScript("location.search='?pieid=9007199254740993';")
        XCTAssertFalse(try readiness(context, expectedURL: expected))
        XCTAssertEqual(context.evaluateScript("document.title")?.toString(), "unmarked")
        context.evaluateScript("location.search='?pieid=9007199254740992';")
        XCTAssertTrue(try readiness(context, expectedURL: expected))
        context.evaluateScript("location.search='?pieid=0009007199254740992';")
        XCTAssertTrue(try readiness(context, expectedURL: expected))
    }

    func testConnectReadinessWaitsForImageVideoAndCanvasResourcesBeforeMarkingPage() throws {
        let cases = [
            ("IMG", "node.complete=false;node.naturalWidth=500;node.naturalHeight=200;",
             "node.complete=true;node.naturalWidth=500;node.naturalHeight=200;"),
            ("IMG", "node.complete=true;node.naturalWidth=0;node.naturalHeight=200;",
             "node.complete=true;node.naturalWidth=500;node.naturalHeight=200;"),
            ("VIDEO", "node.readyState=1;node.videoWidth=500;node.videoHeight=200;",
             "node.readyState=2;node.videoWidth=500;node.videoHeight=200;"),
            ("VIDEO", "node.readyState=2;node.videoWidth=0;node.videoHeight=200;",
             "node.readyState=2;node.videoWidth=500;node.videoHeight=200;"),
            ("CANVAS", "node.width=0;node.height=200;", "node.width=500;node.height=200;"),
            ("CANVAS", "node.width=500;node.height=0;", "node.width=500;node.height=200;")
        ]
        for (tag, pending, loaded) in cases {
            let context = try readinessContext()
            context.setObject(tag, forKeyedSubscript: "resourceTag" as NSString)
            context.evaluateScript("node.tagName=resourceTag;" + pending)
            XCTAssertFalse(try readiness(context), "\(tag) 资源未就绪时不能启动捕获")
            XCTAssertEqual(context.evaluateScript("document.title")?.toString(), "unmarked", "\(tag) 资源未就绪时不能标记为自有预览")
            context.evaluateScript(loaded)
            XCTAssertTrue(try readiness(context), "\(tag) 资源就绪后应允许播放")
            XCTAssertEqual(context.evaluateScript("document.title")?.toString(), "NIO Warp Connect Preview · resources")
        }
    }

    private func readinessContext() throws -> JSContext {
        let context = try XCTUnwrap(JSContext())
        context.evaluateScript(#"""
        var location={origin:'http://localhost:9981',pathname:'/pie',search:'?pieid=1'};
        var URLSearchParams=function(s){this.getAll=n=>s.replace(/^\?/,'').split('&')
          .map(p=>p.split('=')).filter(p=>decodeURIComponent(p[0])===n).map(p=>decodeURIComponent(p[1]||''));};
        var getComputedStyle=e=>({visibility:'visible'});
        var node={tagName:'DIV',getBoundingClientRect:()=>({width:500,height:200})};
        var root={getBoundingClientRect:()=>({width:1920,height:1080}),querySelectorAll:()=>[node]};
        var document={readyState:'complete',title:'unmarked',body:{innerText:''},
          querySelector:s=>s==='#pie-screen'?root:null,querySelectorAll:()=>[]};
        """#)
        XCTAssertNil(context.exception)
        return context
    }

    private func readiness(_ context: JSContext, expectedURL: URL = URL(string: "http://localhost:9981/pie?pieid=1")!) throws -> Bool {
        let expression = ProtoPieSystemDriver.connectReadinessExpression(expectedURL: expectedURL, marker: "NIO Warp Connect Preview · resources")
        let result = try XCTUnwrap(context.evaluateScript(expression)?.toDictionary())
        XCTAssertNil(context.exception)
        return result["ready"] as? Bool == true
    }

    func testConnectMarkedOrphansAreRecognizedWithoutClaimingOtherPages() {
        let targets: [[String: Any]] = [
            ["type":"page","targetId":"owned","title":"NIO Warp Connect Preview · a","url":"http://localhost:9981/pie?pieid=1"],
            ["type":"page","targetId":"user","title":"ProtoPie","url":"http://localhost:9981/pie?pieid=2"],
            ["type":"page","targetId":"other","title":"NIO Warp Connect Preview · b","url":"http://localhost:9981/admin"]
        ]
        XCTAssertEqual(ProtoPieCloudTargetLifecycle.markedOrphans(targets, preserving: []), ["owned"])
        XCTAssertEqual(ProtoPieCloudTargetLifecycle.markedOrphans(targets, preserving: ["owned"]), [])
    }

    func testLaunchCleanupNeverClaimsDifferentConnectPrototype() {
        let wanted = URL(string:"http://localhost:9981/pie?pieid=1")!
        let target: [String: Any] = ["type":"page","targetId":"other","url":"http://localhost:9981/pie?pieid=2"]
        XCTAssertNil(ProtoPieCloudTargetLifecycle.unboundLaunchedTarget([target], excluding: [], expectedURL: wanted))
    }
}
