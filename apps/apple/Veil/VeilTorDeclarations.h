#import <Foundation/Foundation.h>
#import <netinet/in.h>

NS_ASSUME_NONNULL_BEGIN

/// Used only when the Swift package's clang module does not export TorCore's
/// headers to the app. The implementations are the ones linked from CTor.
@interface TORConfiguration : NSObject
@property (nonatomic, copy, nullable) NSURL *dataDirectory;
@property (nonatomic) BOOL ignoreMissingTorrc;
@property (nonatomic) BOOL cookieAuthentication;
@property (nonatomic) BOOL avoidDiskWrites;
@property (nonatomic) BOOL clientOnly;
@property (nonatomic, copy, nullable, readonly) NSData *cookie;
@property (nonatomic, copy, null_resettable) NSMutableArray<NSString *> *arguments;
@end

@interface TORThread : NSThread
+ (nullable TORThread *)activeThread;
- (instancetype)initWithConfiguration:(nullable TORConfiguration *)configuration;
@end

@interface TORController : NSObject
@property (nonatomic, readonly, getter=isConnected) BOOL connected;
- (instancetype)initWithSocketHost:(NSString *)host port:(in_port_t)port;
- (BOOL)connect:(NSError * _Nullable * _Nullable)error;
- (void)disconnect;
- (void)authenticateWithData:(NSData *)data completion:(void (^ _Nullable)(BOOL success, NSError * _Nullable error))completion;
- (id)addObserverForCircuitEstablished:(void (^)(BOOL established))block;
- (id)addObserverForStatusEvents:(BOOL (^)(NSString *type, NSString *severity, NSString *action, NSDictionary<NSString *, NSString *> * _Nullable arguments))block;
- (void)sendCommand:(NSString *)command arguments:(nullable NSArray<NSString *> *)arguments data:(nullable NSData *)data observer:(BOOL (^)(NSArray<NSNumber *> *codes, NSArray<NSData *> *lines, BOOL *stop))observer;
@end

NS_ASSUME_NONNULL_END
