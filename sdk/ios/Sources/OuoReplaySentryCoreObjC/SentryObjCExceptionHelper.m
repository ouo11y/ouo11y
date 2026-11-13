// Copied from getsentry/sentry-cocoa 9.33.0, Sources/Sentry/SentryObjCExceptionHelper.m.
// Copyright (c) 2015 Sentry. MIT License, see sdk/ios/THIRD_PARTY_NOTICES.
// Do not edit: re-vendor with sdk/ios/scripts/sentry-core-sync.sh; ouo code lives outside Upstream/.

#import "SentryObjCExceptionHelper.h"
#import "SentryLogC.h"

@implementation SentryObjCExceptionHelper

+ (BOOL)tryBlock:(NS_NOESCAPE void (^)(void))block
    catchingExceptionWithName:(NSExceptionName)name
                 reasonPrefix:(NSString *)reasonPrefix
{
    @try {
        block();
        return YES;
    } @catch (NSException *exception) {
        if (![exception.name isEqualToString:name] || ![exception.reason hasPrefix:reasonPrefix]) {
            @throw;
        }

        SENTRY_LOG_WARN(@"Caught Objective-C exception %@: %@", exception.name, exception.reason);
        return NO;
    }
}

@end
