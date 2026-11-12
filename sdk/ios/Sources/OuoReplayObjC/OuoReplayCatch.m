#import "OuoReplayObjC.h"

NSString *_Nullable OuoReplayCatch(void (NS_NOESCAPE ^block)(void)) {
    @try {
        block();
        return nil;
    } @catch (NSException *exception) {
        return exception.reason ?: exception.name ?: @"exception";
    } @catch (id other) {
        return @"exception";
    }
}
