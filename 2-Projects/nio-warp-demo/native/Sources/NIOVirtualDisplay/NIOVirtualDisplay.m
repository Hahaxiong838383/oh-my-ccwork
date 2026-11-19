#import "NIOVirtualDisplay.h"
#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#import <objc/runtime.h>
#include <stdio.h>
#include <stdlib.h>

// Private CoreGraphics runtime selectors; no private class is linked directly.
// Runtime shape follows Chromium's ui/display/mac/test/virtual_display_util_mac.mm.
@interface NIOCGVirtualDescriptor : NSObject
@property unsigned int vendorID, productID, serialNum;
@property unsigned int maxPixelsWide, maxPixelsHigh;
@property CGSize sizeInMillimeters;
@property CGPoint redPrimary, greenPrimary, bluePrimary, whitePoint;
@property(strong) NSString *name;
@property(strong) id queue;
@end
@interface NIOCGVirtualMode : NSObject
- (id)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)rate;
@end
@interface NIOCGVirtualSettings : NSObject
@property unsigned int hiDPI;
@property(strong) NSArray *modes;
@end
@interface NIOCGVirtualDisplay : NSObject
@property(readonly) unsigned int displayID;
- (id)initWithDescriptor:(id)descriptor;
- (BOOL)applySettings:(id)settings;
@end

static const uint32_t NIOVendorID = 0x4E49;
static const uint32_t NIOProductID = 0x5752;
static const uint64_t NIOMaxPixels = 67108864;

struct NIOVirtualDisplayHandle {
    CFTypeRef object;
    CGDirectDisplayID displayID;
    uint32_t width, height;
};

static void NIOError(char *buffer, size_t capacity, NSString *message) {
    if (buffer && capacity) snprintf(buffer, capacity, "%s", message.UTF8String ?: "虚拟显示器操作失败。");
}

static BOOL NIOHasSelectors(Class type, NSArray<NSString *> *names, char *error, size_t capacity) {
    if (!type) { NIOError(error, capacity, @"当前 macOS 未提供所需的虚拟显示器接口。"); return NO; }
    for (NSString *name in names) {
        if (!class_getInstanceMethod(type, NSSelectorFromString(name))) {
            NIOError(error, capacity, [NSString stringWithFormat:@"当前 macOS 的虚拟显示器接口不兼容：%@。", name]);
            return NO;
        }
    }
    return YES;
}

static BOOL NIOExactMode(CGDisplayModeRef mode, NIOVirtualDisplayRef display) {
    return mode && CGDisplayModeGetWidth(mode) == display->width
        && CGDisplayModeGetHeight(mode) == display->height
        && CGDisplayModeGetPixelWidth(mode) == display->width
        && CGDisplayModeGetPixelHeight(mode) == display->height;
}

NIOVirtualDisplayRef NIOVirtualDisplayCreate(uint32_t width, uint32_t height, char *error, size_t capacity) {
    @autoreleasepool {
        NIOError(error, capacity, @"");
        if (!width || !height || width > 16384 || height > 16384 || (uint64_t)width * height > NIOMaxPixels) {
            NIOError(error, capacity, @"内容显示尺寸须在 1～16384 之间，且总像素不得超过 67108864。"); return NULL;
        }
        if (![NSThread isMainThread]) {
            NIOError(error, capacity, @"虚拟显示器必须在主线程创建。"); return NULL;
        }
        @try {
            Class descriptorClass = NSClassFromString(@"CGVirtualDisplayDescriptor");
            Class displayClass = NSClassFromString(@"CGVirtualDisplay");
            Class modeClass = NSClassFromString(@"CGVirtualDisplayMode");
            Class settingsClass = NSClassFromString(@"CGVirtualDisplaySettings");
            if (!NIOHasSelectors(descriptorClass, @[@"init", @"setName:", @"setVendorID:", @"setProductID:",
                    @"setSerialNum:", @"setMaxPixelsWide:", @"setMaxPixelsHigh:", @"setSizeInMillimeters:",
                    @"setRedPrimary:", @"setGreenPrimary:", @"setBluePrimary:", @"setWhitePoint:", @"setQueue:"], error, capacity)
                || !NIOHasSelectors(displayClass, @[@"initWithDescriptor:", @"applySettings:", @"displayID"], error, capacity)
                || !NIOHasSelectors(modeClass, @[@"initWithWidth:height:refreshRate:"], error, capacity)
                || !NIOHasSelectors(settingsClass, @[@"init", @"setHiDPI:", @"setModes:"], error, capacity)) return NULL;

            NIOCGVirtualDescriptor *descriptor = [[descriptorClass alloc] init];
            if (!descriptor) { NIOError(error, capacity, @"内容显示器描述资源分配失败。"); return NULL; }
            descriptor.name = @"NIO Warp · 内容画布";
            descriptor.vendorID = NIOVendorID; descriptor.productID = NIOProductID;
            // Stable, distinct identity for every supported dimension pair. Avoid
            // leaving a fresh ColorSync identity behind on every app restart.
            unsigned int serial = 0x40000000u | ((width - 1) << 14) | (height - 1);
            descriptor.serialNum = serial;
            if ([descriptor respondsToSelector:NSSelectorFromString(@"setSerialNumber:")])
                [descriptor setValue:@(serial) forKey:@"serialNumber"];
            descriptor.maxPixelsWide = width; descriptor.maxPixelsHigh = height;
            descriptor.sizeInMillimeters = CGSizeMake(width * 25.4 / 110, height * 25.4 / 110);
            descriptor.redPrimary = CGPointMake(.64, .33); descriptor.greenPrimary = CGPointMake(.30, .60);
            descriptor.bluePrimary = CGPointMake(.15, .06); descriptor.whitePoint = CGPointMake(.3127, .3290);
            descriptor.queue = dispatch_get_main_queue();
            NIOCGVirtualDisplay *object = [[displayClass alloc] initWithDescriptor:descriptor];
            NIOCGVirtualMode *mode = [[modeClass alloc] initWithWidth:width height:height refreshRate:60];
            NIOCGVirtualSettings *settings = [[settingsClass alloc] init];
            if (!descriptor || !object || !mode || !settings) {
                NIOError(error, capacity, @"macOS 未能创建内容虚拟显示器。"); return NULL;
            }
            settings.hiDPI = 0; settings.modes = @[mode];
            if (![object applySettings:settings]) {
                NIOError(error, capacity, @"macOS 未接受所请求的内容显示模式。"); return NULL;
            }
            CGDirectDisplayID displayID = object.displayID;
            if (!displayID) { NIOError(error, capacity, @"macOS 未返回有效的内容显示器编号。"); return NULL; }
            NIOVirtualDisplayRef handle = calloc(1, sizeof(*handle));
            if (!handle) { NIOError(error, capacity, @"内容显示器资源分配失败。"); return NULL; }
            handle->object = CFBridgingRetain(object);
            handle->displayID = displayID; handle->width = width; handle->height = height;
            return handle;
        } @catch (NSException *exception) {
            NIOError(error, capacity, [NSString stringWithFormat:@"创建内容显示器失败：%@", exception.reason ?: exception.name]);
            return NULL;
        }
    }
}

void NIOVirtualDisplayDestroy(NIOVirtualDisplayRef display) {
    if (!display) return;
    @autoreleasepool {
        // Explicitly release the retained owner inside this pool, rather than
        // relying on an outer AppKit pool that may survive shutdown for a while.
        CFTypeRef object = display->object;
        display->object = NULL;
        free(display);
        if (object) CFRelease(object);
    }
}

CGDirectDisplayID NIOVirtualDisplayGetDisplayID(NIOVirtualDisplayRef display) {
    return display ? display->displayID : kCGNullDirectDisplay;
}

int NIOVirtualDisplaySelectExactMode(NIOVirtualDisplayRef display, char *error, size_t capacity) {
    @autoreleasepool {
        NIOError(error, capacity, @"");
        if (!display || !display->object) { NIOError(error, capacity, @"内容显示器已释放。"); return -1; }
        if (![NSThread isMainThread]) { NIOError(error, capacity, @"内容显示模式必须在主线程设置。"); return -1; }
        CGDirectDisplayID displayID = display->displayID;
        // Creation precedes WindowServer enumeration. For a not-yet-known ID,
        // CGDisplayIsOnline can return -1 (not just 0); do not treat it as ready.
        CGDirectDisplayID onlineIDs[64]; uint32_t onlineCount = 0;
        if (CGGetOnlineDisplayList(64, onlineIDs, &onlineCount) != kCGErrorSuccess) return 0;
        BOOL enumerated = NO;
        for (uint32_t i = 0; i < onlineCount; i++) if (onlineIDs[i] == displayID) { enumerated = YES; break; }
        if (!enumerated || CGDisplayIsOnline(displayID) <= 0) return 0;
        if (!NIOVirtualDisplayIsOwnedDisplay(displayID)) {
            if (!CGDisplayVendorNumber(displayID) || !CGDisplayModelNumber(displayID)) return 0;
            NIOError(error, capacity, @"内容显示器身份不匹配，已停止设置模式。"); return -1;
        }
        CGDisplayModeRef current = CGDisplayCopyDisplayMode(displayID);
        BOOL exact = NIOExactMode(current, display);
        if (current) CFRelease(current);
        if (exact) return 1;
        CFArrayRef modes = CGDisplayCopyAllDisplayModes(displayID,
            (__bridge CFDictionaryRef)@{(__bridge NSString *)kCGDisplayShowDuplicateLowResolutionModes: @YES});
        if (!modes) { NIOError(error, capacity, @"系统尚未提供内容显示器模式列表。"); return 0; }
        CGDisplayModeRef target = NULL;
        for (CFIndex index = 0; index < CFArrayGetCount(modes); index++) {
            CGDisplayModeRef mode = (CGDisplayModeRef)CFArrayGetValueAtIndex(modes, index);
            if (NIOExactMode(mode, display)) { target = mode; break; }
        }
        if (!target) {
            CFRelease(modes);
            NIOError(error, capacity, [NSString stringWithFormat:@"系统尚未提供 %u×%u 的 1× 内容显示模式。", display->width, display->height]);
            return 0;
        }
        // Apple's CGDirectDisplay.h documents application-lifetime persistence;
        // do not use permanent configuration, mirroring, or origin changes.
        CGError result = CGDisplaySetDisplayMode(displayID, target, NULL);
        CFRelease(modes);
        if (result != kCGErrorSuccess) {
            NIOError(error, capacity, [NSString stringWithFormat:@"内容显示模式切换失败（系统错误 %d）。", result]); return -1;
        }
        return 1;
    }
}

bool NIOVirtualDisplayMatchesIdentity(uint32_t vendorID, uint32_t productID) {
    return vendorID == NIOVendorID && productID == NIOProductID;
}

bool NIOVirtualDisplayIsOwnedDisplay(CGDirectDisplayID displayID) {
    return displayID != kCGNullDirectDisplay
        && NIOVirtualDisplayMatchesIdentity(CGDisplayVendorNumber(displayID), CGDisplayModelNumber(displayID));
}
