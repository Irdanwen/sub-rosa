// The iPhone's document scanner: VisionKit's camera, a PDF of the pages, and
// Vision's text recognition on each one. Called from Rust (src/scan/ios.rs)
// through one C entry point; the answer is one JSON string, delivered once:
//
//   {"cancelled":true}
//   {"error":"…"}
//   {"pages":[{"lines":[{"text":"…","top":0.12,"bottom":0.14}, …]}, …]}
//
// `top` and `bottom` are fractions of the page height from the top, the units
// the Android half reports too. The PDF is written to the path Rust gives.

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <Vision/Vision.h>
#import <VisionKit/VisionKit.h>

typedef void (*SRScanCallback)(void *context, const char *json);

// Long edge of a page as drawn into the PDF and handed to recognition. A
// phone camera page is about 3000 pixels tall; this keeps text sharp, the PDF
// a few hundred kilobytes a page, and recognition quick.
static const CGFloat SRMaxPageEdge = 2200.0;
// PDF page width in points (US Letter / A4 are both about this wide).
static const CGFloat SRPdfPageWidth = 612.0;

static void SRDeliver(SRScanCallback callback, void *context, NSDictionary *answer) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:answer options:0 error:nil];
    NSString *string = json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]
                            : @"{\"error\":\"invalid_response\"}";
    callback(context, string.UTF8String);
}

static UIViewController *SRFrontmostController(void) {
    UIWindow *keyWindow = nil;
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class]) continue;
        for (UIWindow *window in ((UIWindowScene *)scene).windows) {
            if (!keyWindow) keyWindow = window;
            if (window.isKeyWindow) {
                keyWindow = window;
                break;
            }
        }
    }
    UIViewController *controller = keyWindow.rootViewController;
    while (controller.presentedViewController) controller = controller.presentedViewController;
    return controller;
}

/// The page re-encoded as a JPEG no larger than it needs to be. Drawing a
/// JPEG-backed image into a PDF context embeds the JPEG as is.
static UIImage *SRPreparedPage(UIImage *page) {
    CGSize size = page.size;
    CGFloat longEdge = MAX(size.width, size.height);
    CGFloat scale = longEdge > SRMaxPageEdge ? SRMaxPageEdge / longEdge : 1.0;
    CGSize target = CGSizeMake(floor(size.width * scale), floor(size.height * scale));
    UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat defaultFormat];
    format.scale = 1.0;
    format.opaque = YES;
    UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:target
                                                                               format:format];
    UIImage *resized = [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
        (void)context;
        [page drawInRect:CGRectMake(0, 0, target.width, target.height)];
    }];
    NSData *jpeg = UIImageJPEGRepresentation(resized, 0.75);
    UIImage *decoded = jpeg ? [UIImage imageWithData:jpeg] : nil;
    return decoded ?: resized;
}

static NSArray<NSDictionary *> *SRRecognizedLines(UIImage *page) {
    CGImageRef image = page.CGImage;
    if (!image) return @[];
    VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    request.usesLanguageCorrection = YES;
    if (@available(iOS 16.0, *)) {
        request.automaticallyDetectsLanguage = YES;
    }
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image
                                                                            options:@{}];
    NSError *error = nil;
    if (![handler performRequests:@[ request ] error:&error]) return @[];
    NSMutableArray<NSDictionary *> *lines = [NSMutableArray array];
    for (VNRecognizedTextObservation *observation in request.results) {
        VNRecognizedText *best = [observation topCandidates:1].firstObject;
        if (best.string.length == 0) continue;
        // Vision's box is normalized with its origin at the bottom left.
        CGRect box = observation.boundingBox;
        [lines addObject:@{
            @"text": best.string,
            @"top": @(1.0 - CGRectGetMaxY(box)),
            @"bottom": @(1.0 - CGRectGetMinY(box)),
        }];
    }
    return lines;
}

@interface SRDocumentScanDelegate : NSObject <VNDocumentCameraViewControllerDelegate>
@property(nonatomic, assign) SRScanCallback callback;
@property(nonatomic, assign) void *context;
@property(nonatomic, copy) NSString *pdfPath;
@end

// The camera holds its delegate weakly; this keeps it alive until it answers.
static SRDocumentScanDelegate *activeScan;

@implementation SRDocumentScanDelegate

- (void)finishWith:(NSDictionary *)answer {
    SRDeliver(self.callback, self.context, answer);
    activeScan = nil;
}

- (void)documentCameraViewControllerDidCancel:(VNDocumentCameraViewController *)controller {
    [controller dismissViewControllerAnimated:YES completion:nil];
    [self finishWith:@{ @"cancelled": @YES }];
}

- (void)documentCameraViewController:(VNDocumentCameraViewController *)controller
                    didFailWithError:(NSError *)error {
    [controller dismissViewControllerAnimated:YES completion:nil];
    [self finishWith:@{ @"error": error.localizedDescription ?: @"scan_failed" }];
}

- (void)documentCameraViewController:(VNDocumentCameraViewController *)controller
                   didFinishWithScan:(VNDocumentCameraScan *)scan {
    NSMutableArray<UIImage *> *originals = [NSMutableArray array];
    for (NSUInteger index = 0; index < scan.pageCount; index++) {
        UIImage *page = [scan imageOfPageAtIndex:index];
        if (page) [originals addObject:page];
    }
    [controller dismissViewControllerAnimated:YES completion:nil];
    if (originals.count == 0) {
        [self finishWith:@{ @"cancelled": @YES }];
        return;
    }
    // Recognition takes a second or two a page: never on the main thread.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        @autoreleasepool {
            NSMutableData *pdf = [NSMutableData data];
            NSMutableArray<NSDictionary *> *pages = [NSMutableArray array];
            UIGraphicsBeginPDFContextToData(pdf, CGRectZero, nil);
            for (UIImage *original in originals) {
                @autoreleasepool {
                    UIImage *page = SRPreparedPage(original);
                    CGFloat ratio = page.size.width > 0 ? page.size.height / page.size.width : 1.0;
                    CGRect bounds = CGRectMake(0, 0, SRPdfPageWidth, SRPdfPageWidth * ratio);
                    UIGraphicsBeginPDFPageWithInfo(bounds, nil);
                    [page drawInRect:bounds];
                    [pages addObject:@{ @"lines": SRRecognizedLines(page) }];
                }
            }
            UIGraphicsEndPDFContext();
            NSError *writeError = nil;
            if (![pdf writeToFile:self.pdfPath options:NSDataWritingAtomic error:&writeError]) {
                // The text is still worth a note; Rust finds no PDF to keep.
                NSLog(@"Sub Rosa: scan PDF not written: %@", writeError.localizedDescription);
            }
            [self finishWith:@{ @"pages": pages }];
        }
    });
}

@end

void subrosa_document_scan(const char *pdfPath, void *context, SRScanCallback callback) {
    NSString *path = pdfPath ? [NSString stringWithUTF8String:pdfPath] : nil;
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!path.length) {
            SRDeliver(callback, context, @{ @"error": @"invalid_path" });
            return;
        }
        if (activeScan) {
            SRDeliver(callback, context, @{ @"error": @"already_scanning" });
            return;
        }
        if (!VNDocumentCameraViewController.isSupported) {
            SRDeliver(callback, context, @{ @"error": @"unsupported" });
            return;
        }
        UIViewController *presenter = SRFrontmostController();
        if (!presenter) {
            SRDeliver(callback, context, @{ @"error": @"no_window" });
            return;
        }
        SRDocumentScanDelegate *delegate = [[SRDocumentScanDelegate alloc] init];
        delegate.callback = callback;
        delegate.context = context;
        delegate.pdfPath = path;
        activeScan = delegate;
        VNDocumentCameraViewController *camera = [[VNDocumentCameraViewController alloc] init];
        camera.delegate = delegate;
        // Full screen: a swipe down on a sheet would dismiss the camera
        // without telling its delegate, and the scan would never answer.
        camera.modalPresentationStyle = UIModalPresentationFullScreen;
        [presenter presentViewController:camera animated:YES completion:nil];
    });
}
