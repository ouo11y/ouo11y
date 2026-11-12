#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runs `block` and contains an Objective-C exception it raises (client SDK spec ERR-1: a UIKit
/// call made while walking or rendering the host's views must not take the app down). Returns nil
/// when the block returned, else the exception's reason. Swift cannot catch NSException, hence
/// this one function in Objective-C. Swift frames the exception unwinds through are not cleaned
/// up, so the block should hold nothing that must be released; the caller drops the frame.
FOUNDATION_EXPORT NSString *_Nullable OuoReplayCatch(void (NS_NOESCAPE ^block)(void));

NS_ASSUME_NONNULL_END
