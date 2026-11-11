#import "VeilTorGlue.h"

#if __has_include(<TORConfiguration.h>) && __has_include(<TORController.h>) && __has_include(<TORThread.h>)
#import <TORConfiguration.h>
#import <TORController.h>
#import <TORThread.h>
#else
#import "VeilTorDeclarations.h"
#endif

#import <arpa/inet.h>
#import <netinet/in.h>
#import <string.h>
#import <sys/socket.h>
#import <unistd.h>

@interface VeilTorSession ()
@property (nonatomic, strong, nullable) TORConfiguration *configuration;
@property (nonatomic, copy, nullable) NSURL *cookieURL;
@property (nonatomic, strong, nullable) TORThread *thread;
@property (nonatomic, strong, nullable) TORController *controller;
@property (nonatomic, copy, nullable) void (^progressBlock)(NSInteger, NSString *, BOOL, BOOL);
@property (nonatomic, copy, nullable) void (^completionBlock)(BOOL, NSString *);
@property (nonatomic, copy) NSString *controlHost;
@property (nonatomic) NSUInteger controlPort;
@property (nonatomic) NSInteger progress;
@property (nonatomic, copy) NSString *summary;
@property (nonatomic) BOOL circuitUp;
@property (nonatomic) BOOL didFinish;
@property (nonatomic) BOOL acceptingEvents;
@property (nonatomic) BOOL cancelled;
@end

@implementation VeilTorSession

- (instancetype)init {
    self = [super init];
    if (!self) return nil;
    _controlHost = @"127.0.0.1";
    _summary = @"";
    return self;
}

- (void)startWithTorrc:(NSURL *)torrc
         dataDirectory:(NSURL *)dataDirectory
           controlHost:(NSString *)controlHost
           controlPort:(NSUInteger)controlPort
              progress:(void (^)(NSInteger, NSString *, BOOL, BOOL))progress
            completion:(void (^)(BOOL, NSString *))completion {
    self.progressBlock = progress;
    self.completionBlock = completion;
    self.controlHost = controlHost;
    self.controlPort = controlPort;
    self.cancelled = NO;
    self.didFinish = NO;
    self.acceptingEvents = NO;
    self.circuitUp = NO;
    self.progress = 0;
    self.summary = @"";

    if (controlPort == 0 || controlPort > 65535 || ![controlHost isEqualToString:@"127.0.0.1"]) {
        [self finish:NO message:@"Tor control must stay on 127.0.0.1."];
        return;
    }
    if (TORThread.activeThread != nil) {
        [self finish:NO message:@"Tor is already running in this process."];
        return;
    }

    NSFileManager *files = NSFileManager.defaultManager;
    [files createDirectoryAtURL:dataDirectory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions: @0700} error:nil];

    // The torrc already carries SocksPort, ControlPort, CookieAuthentication,
    // DataDirectory, and ClientOnly. Passing those again on the command line
    // makes Tor reject the duplicate. dataDirectory is kept only so we can
    // read the cookie file Tor writes there.
    TORConfiguration *configuration = [TORConfiguration new];
    configuration.ignoreMissingTorrc = YES;
    [configuration.arguments addObjectsFromArray:@[@"-f", torrc.path]];
    self.configuration = configuration;
    self.cookieURL = [dataDirectory URLByAppendingPathComponent:@"control_auth_cookie"];

    TORThread *thread = [[TORThread alloc] initWithConfiguration:configuration];
    self.thread = thread;
    [thread start];
    [self schedulePoll];
}

- (void)sendCommand:(NSString *)command completion:(void (^)(BOOL))completion {
    TORController *controller = self.controller;
    if (command.length == 0 || controller == nil || !controller.isConnected) {
        dispatch_async(dispatch_get_main_queue(), ^{
            completion(NO);
        });
        return;
    }
    [controller sendCommand:command arguments:nil data:nil observer:^BOOL(NSArray<NSNumber *> *codes, NSArray<NSData *> *lines, BOOL *stop) {
        (void)lines;
        NSInteger code = codes.firstObject.integerValue;
        if (code == 0) return NO;
        *stop = YES;
        BOOL ok = code == 250;
        dispatch_async(dispatch_get_main_queue(), ^{
            completion(ok);
        });
        return YES;
    }];
}

- (void)shutdown {
    self.cancelled = YES;
    [self.controller disconnect];
    self.controller = nil;
    self.circuitUp = NO;
    [self emitProgress:self.progress summary:(self.summary.length ? self.summary : @"Tor stopped.") circuit:NO alive:NO];
    [self finish:NO message:@"Tor stopped."];
}

- (void)schedulePoll {
    __weak VeilTorSession *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.25 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        [weakSelf poll];
    });
}

- (void)poll {
    if (self.cancelled || self.didFinish || self.acceptingEvents) return;
    if (self.thread.isFinished) {
        [self finish:NO message:@"Tor stopped before the circuit was ready. Browsing stays paused."];
        return;
    }
    NSData *cookie = self.cookieURL ? [NSData dataWithContentsOfURL:(NSURL * _Nonnull)self.cookieURL] : nil;
    if (cookie.length > 0 && [self controlPortOpen]) {
        TORController *controller = [[TORController alloc] initWithSocketHost:self.controlHost port:(in_port_t)self.controlPort];
        if (!controller.isConnected) {
            [controller connect:nil];
        }
        if (!controller.isConnected) {
            [self schedulePoll];
            return;
        }
        self.controller = controller;
        __weak VeilTorSession *weakSelf = self;
        [controller authenticateWithData:cookie completion:^(BOOL success, NSError *error) {
            dispatch_async(dispatch_get_main_queue(), ^{
                VeilTorSession *strong = weakSelf;
                if (!strong || strong.cancelled || strong.didFinish) return;
                if (!success) {
                    NSString *message = error.localizedDescription.length ? error.localizedDescription : @"Tor control authentication failed.";
                    [strong finish:NO message:message];
                    return;
                }
                [strong observe];
            });
        }];
        return;
    }
    [self schedulePoll];
}

- (void)observe {
    if (self.acceptingEvents || self.cancelled || self.didFinish) return;
    self.acceptingEvents = YES;
    TORController *controller = self.controller;
    __weak VeilTorSession *weakSelf = self;
    [controller addObserverForStatusEvents:^BOOL(NSString *type, NSString *severity, NSString *action, NSDictionary<NSString *, NSString *> *arguments) {
        (void)severity;
        if (![type isEqualToString:@"STATUS_CLIENT"] || ![action isEqualToString:@"BOOTSTRAP"]) return NO;
        NSInteger clamped = arguments[@"PROGRESS"].integerValue;
        if (clamped < 0) clamped = 0;
        if (clamped > 100) clamped = 100;
        NSString *summary = arguments[@"SUMMARY"] ?: @"";
        dispatch_async(dispatch_get_main_queue(), ^{
            VeilTorSession *strong = weakSelf;
            if (!strong || strong.cancelled) return;
            strong.progress = clamped;
            if (summary.length) strong.summary = summary;
            BOOL alive = !strong.thread.isFinished;
            [strong emitProgress:clamped summary:strong.summary circuit:strong.circuitUp alive:alive];
            if (!alive) {
                [strong finish:NO message:@"Tor stopped before the circuit was ready. Browsing stays paused."];
            }
        });
        return NO;
    }];
    [controller addObserverForCircuitEstablished:^(BOOL established) {
        dispatch_async(dispatch_get_main_queue(), ^{
            VeilTorSession *strong = weakSelf;
            if (!strong || strong.cancelled || strong.didFinish) return;
            strong.circuitUp = established;
            BOOL alive = !strong.thread.isFinished;
            if (established && alive) {
                strong.progress = 100;
                if (!strong.summary.length) strong.summary = @"Connected to Tor";
                [strong emitProgress:100 summary:strong.summary circuit:YES alive:YES];
                [strong finish:YES message:strong.summary];
            } else if (!alive) {
                [strong emitProgress:strong.progress summary:strong.summary circuit:NO alive:NO];
                [strong finish:NO message:@"Tor stopped. Browsing stays paused."];
            } else {
                [strong emitProgress:strong.progress summary:strong.summary circuit:NO alive:YES];
            }
        });
    }];
}

- (BOOL)controlPortOpen {
    int fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (fd < 0) return NO;
    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_port = htons((uint16_t)self.controlPort);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_len = (uint8_t)sizeof(address);
    int result = connect(fd, (struct sockaddr *)&address, (socklen_t)sizeof(address));
    close(fd);
    return result == 0;
}

- (void)emitProgress:(NSInteger)progress summary:(NSString *)summary circuit:(BOOL)circuit alive:(BOOL)alive {
    void (^block)(NSInteger, NSString *, BOOL, BOOL) = self.progressBlock;
    if (!block) return;
    NSString *text = summary ?: @"";
    void (^send)(void) = ^{
        block(progress, text, circuit, alive);
    };
    if (NSThread.isMainThread) send();
    else dispatch_async(dispatch_get_main_queue(), send);
}

- (void)finish:(BOOL)ready message:(NSString *)message {
    if (self.didFinish) return;
    self.didFinish = YES;
    void (^block)(BOOL, NSString *) = self.completionBlock;
    self.completionBlock = nil;
    if (!block) return;
    NSString *text = message ?: @"";
    void (^send)(void) = ^{
        block(ready, text);
    };
    if (NSThread.isMainThread) send();
    else dispatch_async(dispatch_get_main_queue(), send);
}

@end
