#ifndef NIO_VIRTUAL_DISPLAY_H
#define NIO_VIRTUAL_DISPLAY_H

#include <CoreGraphics/CoreGraphics.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct NIOVirtualDisplayHandle *NIOVirtualDisplayRef;

/// Creation and selection must run on the main thread. Neither function waits
/// for WindowServer; the caller must verify active, logical and pixel modes.
/// Width/height are 1x pixels: 1...16384, at most 67,108,864 pixels in total.
NIOVirtualDisplayRef NIOVirtualDisplayCreate(uint32_t width, uint32_t height,
                                           char *error, size_t errorCapacity);
/// Consumes one handle; NULL is accepted. Never use the handle after destroying.
void NIOVirtualDisplayDestroy(NIOVirtualDisplayRef display);
CGDirectDisplayID NIOVirtualDisplayGetDisplayID(NIOVirtualDisplayRef display);

/// 1: exact mode selected/already current; 0: mode list not ready; -1: failure.
/// CGDisplaySetDisplayMode is temporary for the lifetime of the application.
int NIOVirtualDisplaySelectExactMode(NIOVirtualDisplayRef display,
                                     char *error, size_t errorCapacity);

/// Identity distinguishes NIO's source-only displays from physical outputs and
/// the temporary vendor-505 probe. Does not claim ownership of another handle.
bool NIOVirtualDisplayIsOwnedDisplay(CGDirectDisplayID displayID);
bool NIOVirtualDisplayMatchesIdentity(uint32_t vendorID, uint32_t productID);

#ifdef __cplusplus
}
#endif
#endif
