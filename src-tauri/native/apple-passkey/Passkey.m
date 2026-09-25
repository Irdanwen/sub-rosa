#import <AuthenticationServices/AuthenticationServices.h>
#import <Foundation/Foundation.h>
#import <TargetConditionals.h>
#if TARGET_OS_IOS
#import <UIKit/UIKit.h>
#else
#import <AppKit/AppKit.h>
#endif

typedef void (*SRPasskeyCallback)(void *context, const char *json);

static NSString *SREncode(NSData *data) {
    NSString *base64 = [data base64EncodedStringWithOptions:0];
    return [[[base64 stringByReplacingOccurrencesOfString:@"+" withString:@"-"]
             stringByReplacingOccurrencesOfString:@"/" withString:@"_"]
            stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"="]];
}

static NSData *SRDecode(NSString *text) {
    if (![text isKindOfClass:NSString.class] || text.length > 2048) return nil;
    NSString *base64 = [[text stringByReplacingOccurrencesOfString:@"-" withString:@"+"]
                        stringByReplacingOccurrencesOfString:@"_" withString:@"/"];
    while (base64.length % 4) base64 = [base64 stringByAppendingString:@"="];
    return [[NSData alloc] initWithBase64EncodedString:base64 options:0];
}

@interface SRPasskeyDelegate : NSObject <ASAuthorizationControllerDelegate,
                                        ASAuthorizationControllerPresentationContextProviding>
@property(nonatomic, assign) SRPasskeyCallback callback;
@property(nonatomic, assign) void *context;
@property(nonatomic, strong) ASAuthorizationController *controller;
@end

static SRPasskeyDelegate *activePasskeyRequest;

static void SRDeliver(SRPasskeyCallback callback, void *context, NSDictionary *answer) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:answer options:0 error:nil];
    NSString *string = json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]
                            : @"{\"error\":\"invalid_response\"}";
    callback(context, string.UTF8String);
}

@implementation SRPasskeyDelegate
- (ASPresentationAnchor)presentationAnchorForAuthorizationController:(ASAuthorizationController *)controller {
    (void)controller;
#if TARGET_OS_IOS
    UIWindow *firstWindow = nil;
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        for (UIWindow *window in ((UIWindowScene *)scene).windows) {
            if (!firstWindow) firstWindow = window;
            if (window.isKeyWindow) return window;
        }
    }
    return firstWindow;
#else
    return NSApplication.sharedApplication.keyWindow ?: NSApplication.sharedApplication.mainWindow;
#endif
}
- (void)authorizationController:(ASAuthorizationController *)controller
    didCompleteWithAuthorization:(ASAuthorization *)authorization {
    (void)controller;
    id credential = authorization.credential;
    if (![credential conformsToProtocol:@protocol(ASAuthorizationPublicKeyCredentialAssertion)]) {
        SRDeliver(self.callback, self.context, @{ @"error": @"unexpected_credential" });
    } else {
        id<ASAuthorizationPublicKeyCredentialAssertion> assertion = credential;
        if (!assertion.credentialID || !assertion.rawAuthenticatorData ||
            !assertion.rawClientDataJSON || !assertion.signature) {
            SRDeliver(self.callback, self.context, @{ @"error": @"invalid_response" });
            activePasskeyRequest = nil;
            return;
        }
        NSString *idString = SREncode(assertion.credentialID);
        NSDictionary *response = @{
            @"authenticatorData": SREncode(assertion.rawAuthenticatorData),
            @"clientDataJSON": SREncode(assertion.rawClientDataJSON),
            @"signature": SREncode(assertion.signature),
            @"userHandle": assertion.userID ? SREncode(assertion.userID) : [NSNull null]
        };
        SRDeliver(self.callback, self.context, @{
            @"credential": @{
                @"id": idString, @"rawId": idString, @"type": @"public-key",
                @"response": response, @"clientExtensionResults": @{}
            }
        });
    }
    activePasskeyRequest = nil;
}
- (void)authorizationController:(ASAuthorizationController *)controller
             didCompleteWithError:(NSError *)error {
    (void)controller;
    (void)error;
    SRDeliver(self.callback, self.context, @{ @"error": @"passkey_unavailable" });
    activePasskeyRequest = nil;
}
@end

void subrosa_apple_passkey_get(const char *options_json, void *context, SRPasskeyCallback callback) {
    NSString *input = options_json ? [NSString stringWithUTF8String:options_json] : nil;
    dispatch_async(dispatch_get_main_queue(), ^{
        if (activePasskeyRequest) {
            SRDeliver(callback, context, @{ @"error": @"passkey_busy" });
            return;
        }
        NSData *bytes = [input dataUsingEncoding:NSUTF8StringEncoding];
        id parsed = bytes ? [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil] : nil;
        NSDictionary *options = [parsed isKindOfClass:NSDictionary.class] ? parsed : nil;
        NSString *rpId = options[@"rpId"];
        NSData *challenge = SRDecode(options[@"challenge"]);
        if (![rpId isKindOfClass:NSString.class] ||
            ![rpId isEqualToString:@"subrosa.furetier.com"] || challenge.length != 32) {
            SRDeliver(callback, context, @{ @"error": @"passkey_request_invalid" });
            return;
        }
        ASAuthorizationPlatformPublicKeyCredentialProvider *provider =
            [[ASAuthorizationPlatformPublicKeyCredentialProvider alloc]
             initWithRelyingPartyIdentifier:rpId];
        ASAuthorizationPlatformPublicKeyCredentialAssertionRequest *request =
            [provider createCredentialAssertionRequestWithChallenge:challenge];
        request.userVerificationPreference = ASAuthorizationPublicKeyCredentialUserVerificationPreferenceRequired;
        ASAuthorizationController *controller = [[ASAuthorizationController alloc]
                                                 initWithAuthorizationRequests:@[request]];
        SRPasskeyDelegate *delegate = [SRPasskeyDelegate new];
        delegate.callback = callback;
        delegate.context = context;
        delegate.controller = controller;
        controller.delegate = delegate;
        controller.presentationContextProvider = delegate;
        activePasskeyRequest = delegate;
        [controller performRequests];
    });
}
