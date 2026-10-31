// Compile-only: every public Objective-C call of OuoSDK (mobile SDK spec section 5, ADR-0015
// decision 3). Built for iOS by CI (the package scheme); never linked into an app.
@import Foundation;
@import OuoSDK;
#import "OuoObjCSmoke.h"

void OuoObjCSmokeRun(void) {
    OuoConfig *config = [[OuoConfig alloc] initWithEndpoint:[NSURL URLWithString:@"https://otel.example.com"] projectId:@"demo" projectToken:@"pt" serviceName:@"objc"];
    config.environment = @"smoke";
    config.propagateTo = @[@"https://api.example.com"];
    config.tapLabels = NO;
    [Ouo start:config];
    [Ouo setUser:@"u1"];
    [Ouo trackScreen:@"Home"];
    [Ouo trackTap:@"buy"];
    [Ouo addEvent:@"checkout" attributes:@{@"items": @3, @"express": @YES}];
    [Ouo log:OuoLogLevelInfo message:@"line" attributes:nil];
    [Ouo captureError:[NSError errorWithDomain:@"d" code:1 userInfo:nil] attributes:nil];
    [Ouo captureException:[NSException exceptionWithName:@"E" reason:@"r" userInfo:nil] attributes:nil];
    OuoSpan *span = [Ouo startSpan:@"work" attributes:nil];
    [span setAttribute:@"k" value:@1];
    [span setError:@"failed"];
    [span end];
    [Ouo withSpan:@"block" attributes:nil block:^(OuoSpan *s) { [s setAttribute:@"inside" value:@YES]; }];
    NSString *feedbackId = [Ouo feedback:@"slow" contact:nil screenshot:NO];
    (void)feedbackId;
    [Ouo reportFullyDisplayed];
    [Ouo flushWithCompletion:^{}];
    (void)Ouo.sessionId;
}
