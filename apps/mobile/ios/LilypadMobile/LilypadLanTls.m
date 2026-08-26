#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(LilypadLanTls, RCTEventEmitter)

RCT_EXTERN_METHOD(fetch:(NSString *)urlString
                  expectedSha256:(NSString *)expectedSha256
                  method:(NSString *)method
                  headers:(NSDictionary *)headers
                  body:(NSString *)body
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(connectWebSocket:(NSString *)urlString
                  expectedSha256:(NSString *)expectedSha256
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sendWebSocket:(nonnull NSNumber *)socketId
                  text:(NSString *)text)

RCT_EXTERN_METHOD(closeWebSocket:(nonnull NSNumber *)socketId)

RCT_EXTERN_METHOD(browseLilypad:(NSString *)desktopDeviceId
                  timeoutMs:(nonnull NSNumber *)timeoutMs
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
