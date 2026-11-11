#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// In-process Tor. The progress and completion blocks are called on the main queue.
@interface VeilTorSession : NSObject

- (void)startWithTorrc:(NSURL *)torrc
         dataDirectory:(NSURL *)dataDirectory
           controlHost:(NSString *)controlHost
           controlPort:(NSUInteger)controlPort
              progress:(void (^)(NSInteger progress, NSString *summary, BOOL circuitUp, BOOL threadAlive))progress
            completion:(void (^)(BOOL ready, NSString *message))completion;

- (void)sendCommand:(NSString *)command completion:(void (^)(BOOL ok))completion;

- (void)shutdown;

@end

NS_ASSUME_NONNULL_END
