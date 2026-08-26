#import <React/RCTBridgeModule.h>

/**
 * Objective-C surface for `LilypadStoreKit.swift`.
 *
 * RCT_EXTERN_MODULE is enough: New Architecture still loads classic
 * RCTBridgeModule interop, and we deliberately skip TurboModule codegen for
 * this one-off StoreKit surface.
 */
@interface RCT_EXTERN_MODULE(LilypadStoreKit, NSObject)

RCT_EXTERN_METHOD(getProduct:(NSString *)productId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(purchase:(NSString *)productId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(restore:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(latestTransaction:(NSString *)productId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
