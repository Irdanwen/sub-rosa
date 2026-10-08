// The iPhone's health store, read only (ADR-0099). Called from Rust
// (src/health/native.rs) through three C entry points; each answer is one
// JSON string, delivered once:
//
//   subrosa_health_available()          1 when this device has a store
//   subrosa_health_request(metrics)     {"ok":true} | {"error":"…"}
//   subrosa_health_read(request)        {"days":[{"metric","day","value","low","high","samples"}, …]}
//
// `metrics` is a JSON array of the app's keys (steps, sleep, heart_rate,
// resting_heart_rate, workouts, weight); `request` is
// {"metrics":[…],"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}, both days included,
// in the phone's calendar. The Android half (HealthConnect.kt) answers the
// same shape.
//
// Nothing is ever written: the authorization asks to read only. HealthKit
// never says whether a read was refused (a refusal reads as no data), so an
// empty answer is the honest one.

#import <Foundation/Foundation.h>
#import <HealthKit/HealthKit.h>

typedef void (*SRHealthCallback)(void *context, const char *json);

static HKHealthStore *SRStore(void) {
    static HKHealthStore *store;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        store = [[HKHealthStore alloc] init];
    });
    return store;
}

static void SRDeliver(SRHealthCallback callback, void *context, NSDictionary *answer) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:answer options:0 error:nil];
    NSString *string = json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]
                            : @"{\"error\":\"invalid_response\"}";
    callback(context, string.UTF8String);
}

static id SRParse(const char *json) {
    if (!json) return nil;
    NSData *data = [NSData dataWithBytes:json length:strlen(json)];
    return [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
}

static NSSet<HKObjectType *> *SRReadTypes(NSArray *metrics) {
    NSMutableSet<HKObjectType *> *types = [NSMutableSet set];
    for (id metric in metrics) {
        if (![metric isKindOfClass:NSString.class]) continue;
        HKObjectType *type = nil;
        if ([metric isEqualToString:@"steps"]) {
            type = [HKObjectType quantityTypeForIdentifier:HKQuantityTypeIdentifierStepCount];
        } else if ([metric isEqualToString:@"heart_rate"]) {
            type = [HKObjectType quantityTypeForIdentifier:HKQuantityTypeIdentifierHeartRate];
        } else if ([metric isEqualToString:@"resting_heart_rate"]) {
            type = [HKObjectType quantityTypeForIdentifier:HKQuantityTypeIdentifierRestingHeartRate];
        } else if ([metric isEqualToString:@"weight"]) {
            type = [HKObjectType quantityTypeForIdentifier:HKQuantityTypeIdentifierBodyMass];
        } else if ([metric isEqualToString:@"sleep"]) {
            type = [HKObjectType categoryTypeForIdentifier:HKCategoryTypeIdentifierSleepAnalysis];
        } else if ([metric isEqualToString:@"workouts"]) {
            type = [HKObjectType workoutType];
        }
        if (type) [types addObject:type];
    }
    return types;
}

int subrosa_health_available(void) {
    return HKHealthStore.isHealthDataAvailable ? 1 : 0;
}

void subrosa_health_request(const char *metricsJson, void *context, SRHealthCallback callback) {
    id metrics = SRParse(metricsJson);
    if (!HKHealthStore.isHealthDataAvailable) {
        SRDeliver(callback, context, @{@"error" : @"unavailable"});
        return;
    }
    NSSet<HKObjectType *> *types = SRReadTypes([metrics isKindOfClass:NSArray.class] ? metrics : @[]);
    if (types.count == 0) {
        SRDeliver(callback, context, @{@"ok" : @YES});
        return;
    }
    // A build without the HealthKit entitlement or the usage description
    // raises here instead of answering: say so rather than crash.
    @try {
        [SRStore() requestAuthorizationToShareTypes:nil
                                          readTypes:types
                                         completion:^(BOOL success, NSError *error) {
                                             if (success) {
                                                 SRDeliver(callback, context, @{@"ok" : @YES});
                                             } else {
                                                 SRDeliver(callback, context, @{
                                                     @"error" : error.localizedDescription ?: @"denied"
                                                 });
                                             }
                                         }];
    } @catch (NSException *exception) {
        SRDeliver(callback, context, @{@"error" : exception.reason ?: @"unavailable"});
    }
}

static NSDateFormatter *SRDayFormatter(void) {
    static NSDateFormatter *formatter;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        formatter = [[NSDateFormatter alloc] init];
        formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
        formatter.calendar = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
        formatter.timeZone = NSTimeZone.localTimeZone;
        formatter.dateFormat = @"yyyy-MM-dd";
    });
    return formatter;
}

static NSDictionary *SRDay(NSString *metric, NSDate *date, double value, NSNumber *low, NSNumber *high, NSInteger samples) {
    return @{
        @"metric" : metric,
        @"day" : [SRDayFormatter() stringFromDate:date],
        @"value" : @(value),
        @"low" : low ?: (id)NSNull.null,
        @"high" : high ?: (id)NSNull.null,
        @"samples" : @(samples),
    };
}

/// One value a day from HealthKit's own daily statistics: a sum for steps,
/// an average (and range) for heart rate and weight.
static void SRStatistics(NSString *metric, HKQuantityTypeIdentifier identifier, HKStatisticsOptions options,
                         HKUnit *unit, NSDate *start, NSDate *end, dispatch_group_t group,
                         dispatch_queue_t collect, NSMutableArray *days) {
    HKQuantityType *type = [HKQuantityType quantityTypeForIdentifier:identifier];
    NSDateComponents *interval = [[NSDateComponents alloc] init];
    interval.day = 1;
    NSPredicate *predicate = [HKQuery predicateForSamplesWithStartDate:start
                                                               endDate:end
                                                               options:HKQueryOptionStrictStartDate];
    HKStatisticsCollectionQuery *query =
        [[HKStatisticsCollectionQuery alloc] initWithQuantityType:type
                                          quantitySamplePredicate:predicate
                                                          options:options
                                                       anchorDate:start
                                               intervalComponents:interval];
    dispatch_group_enter(group);
    query.initialResultsHandler = ^(HKStatisticsCollectionQuery *q, HKStatisticsCollection *results, NSError *error) {
        NSMutableArray *found = [NSMutableArray array];
        [results enumerateStatisticsFromDate:start
                                      toDate:end
                                   withBlock:^(HKStatistics *statistics, BOOL *stop) {
                                       HKQuantity *value = (options & HKStatisticsOptionCumulativeSum)
                                                               ? statistics.sumQuantity
                                                               : statistics.averageQuantity;
                                       if (!value) return;
                                       NSNumber *low = nil;
                                       NSNumber *high = nil;
                                       if (options & HKStatisticsOptionDiscreteMin && statistics.minimumQuantity) {
                                           low = @([statistics.minimumQuantity doubleValueForUnit:unit]);
                                       }
                                       if (options & HKStatisticsOptionDiscreteMax && statistics.maximumQuantity) {
                                           high = @([statistics.maximumQuantity doubleValueForUnit:unit]);
                                       }
                                       [found addObject:SRDay(metric, statistics.startDate,
                                                              [value doubleValueForUnit:unit], low, high, 0)];
                                   }];
        dispatch_async(collect, ^{
            [days addObjectsFromArray:found];
            dispatch_group_leave(group);
        });
    };
    [SRStore() executeQuery:query];
}

/// Minutes asleep, counted on the morning the night ended. Overlapping
/// samples (the watch and the phone both recording one night) are merged,
/// so a night is never counted twice. In bed and awake are not sleep.
static void SRSleep(NSDate *start, NSDate *end, NSString *from, NSString *to, dispatch_group_t group,
                    dispatch_queue_t collect, NSMutableArray *days) {
    HKCategoryType *type = [HKObjectType categoryTypeForIdentifier:HKCategoryTypeIdentifierSleepAnalysis];
    // A night that ends on the first day began the evening before.
    NSDate *evening = [start dateByAddingTimeInterval:-18 * 3600];
    NSPredicate *predicate = [HKQuery predicateForSamplesWithStartDate:evening endDate:end options:0];
    NSSortDescriptor *byStart = [NSSortDescriptor sortDescriptorWithKey:HKSampleSortIdentifierStartDate ascending:YES];
    dispatch_group_enter(group);
    HKSampleQuery *query = [[HKSampleQuery alloc]
        initWithSampleType:type
                 predicate:predicate
                     limit:HKObjectQueryNoLimit
           sortDescriptors:@[ byStart ]
            resultsHandler:^(HKSampleQuery *q, NSArray<__kindof HKSample *> *samples, NSError *error) {
                // 1 asleep (unspecified), 3 core, 4 deep, 5 REM. 0 is in bed, 2 awake.
                NSMutableDictionary<NSString *, NSMutableArray<NSArray<NSDate *> *> *> *nights =
                    [NSMutableDictionary dictionary];
                for (HKCategorySample *sample in samples) {
                    NSInteger value = sample.value;
                    if (!(value == 1 || value == 3 || value == 4 || value == 5)) continue;
                    NSString *day = [SRDayFormatter() stringFromDate:sample.endDate];
                    if ([day compare:from] == NSOrderedAscending || [day compare:to] == NSOrderedDescending) continue;
                    if (!nights[day]) nights[day] = [NSMutableArray array];
                    [nights[day] addObject:@[ sample.startDate, sample.endDate ]];
                }
                NSMutableArray *found = [NSMutableArray array];
                for (NSString *day in nights) {
                    NSArray *spans = [nights[day] sortedArrayUsingComparator:^NSComparisonResult(NSArray *a, NSArray *b) {
                        return [a[0] compare:b[0]];
                    }];
                    NSTimeInterval asleep = 0;
                    NSDate *spanStart = nil;
                    NSDate *spanEnd = nil;
                    NSInteger merged = 0;
                    for (NSArray<NSDate *> *span in spans) {
                        if (spanEnd && [span[0] compare:spanEnd] != NSOrderedDescending) {
                            if ([span[1] compare:spanEnd] == NSOrderedDescending) spanEnd = span[1];
                            continue;
                        }
                        if (spanStart) asleep += [spanEnd timeIntervalSinceDate:spanStart];
                        spanStart = span[0];
                        spanEnd = span[1];
                        merged += 1;
                    }
                    if (spanStart) asleep += [spanEnd timeIntervalSinceDate:spanStart];
                    if (asleep <= 0) continue;
                    NSDate *date = [SRDayFormatter() dateFromString:day];
                    if (!date) continue;
                    [found addObject:SRDay(@"sleep", date, round(asleep / 60.0), nil, nil, merged)];
                }
                dispatch_async(collect, ^{
                    [days addObjectsFromArray:found];
                    dispatch_group_leave(group);
                });
            }];
    [SRStore() executeQuery:query];
}

/// Minutes of exercise and how many workouts, by the day each began.
static void SRWorkouts(NSDate *start, NSDate *end, dispatch_group_t group, dispatch_queue_t collect,
                       NSMutableArray *days) {
    NSPredicate *predicate = [HKQuery predicateForSamplesWithStartDate:start
                                                               endDate:end
                                                               options:HKQueryOptionStrictStartDate];
    dispatch_group_enter(group);
    HKSampleQuery *query = [[HKSampleQuery alloc]
        initWithSampleType:[HKObjectType workoutType]
                 predicate:predicate
                     limit:HKObjectQueryNoLimit
           sortDescriptors:nil
            resultsHandler:^(HKSampleQuery *q, NSArray<__kindof HKSample *> *samples, NSError *error) {
                NSMutableDictionary<NSString *, NSNumber *> *minutes = [NSMutableDictionary dictionary];
                NSMutableDictionary<NSString *, NSNumber *> *counts = [NSMutableDictionary dictionary];
                for (HKWorkout *workout in samples) {
                    NSString *day = [SRDayFormatter() stringFromDate:workout.startDate];
                    minutes[day] = @(minutes[day].doubleValue + workout.duration / 60.0);
                    counts[day] = @(counts[day].integerValue + 1);
                }
                NSMutableArray *found = [NSMutableArray array];
                for (NSString *day in minutes) {
                    NSDate *date = [SRDayFormatter() dateFromString:day];
                    if (!date) continue;
                    [found addObject:SRDay(@"workouts", date, round(minutes[day].doubleValue), nil, nil,
                                           counts[day].integerValue)];
                }
                dispatch_async(collect, ^{
                    [days addObjectsFromArray:found];
                    dispatch_group_leave(group);
                });
            }];
    [SRStore() executeQuery:query];
}

void subrosa_health_read(const char *requestJson, void *context, SRHealthCallback callback) {
    NSDictionary *request = SRParse(requestJson);
    if (![request isKindOfClass:NSDictionary.class] || !HKHealthStore.isHealthDataAvailable) {
        SRDeliver(callback, context, @{@"error" : @"unavailable"});
        return;
    }
    NSArray *metrics = [request[@"metrics"] isKindOfClass:NSArray.class] ? request[@"metrics"] : @[];
    NSString *from = request[@"from"];
    NSString *to = request[@"to"];
    NSDate *first = [from isKindOfClass:NSString.class] ? [SRDayFormatter() dateFromString:from] : nil;
    NSDate *last = [to isKindOfClass:NSString.class] ? [SRDayFormatter() dateFromString:to] : nil;
    if (!first || !last) {
        SRDeliver(callback, context, @{@"error" : @"invalid_request"});
        return;
    }
    NSCalendar *calendar = NSCalendar.currentCalendar;
    NSDate *start = [calendar startOfDayForDate:first];
    NSDate *end = [calendar dateByAddingUnit:NSCalendarUnitDay value:1 toDate:[calendar startOfDayForDate:last] options:0];
    NSMutableArray *days = [NSMutableArray array];
    dispatch_group_t group = dispatch_group_create();
    dispatch_queue_t collect = dispatch_queue_create("xyz.carpediem.subrosa.health", DISPATCH_QUEUE_SERIAL);
    HKUnit *perMinute = [[HKUnit countUnit] unitDividedByUnit:[HKUnit minuteUnit]];
    HKStatisticsOptions range = HKStatisticsOptionDiscreteAverage | HKStatisticsOptionDiscreteMin |
                                HKStatisticsOptionDiscreteMax;
    for (id metric in metrics) {
        if ([metric isEqual:@"steps"]) {
            SRStatistics(@"steps", HKQuantityTypeIdentifierStepCount, HKStatisticsOptionCumulativeSum,
                         [HKUnit countUnit], start, end, group, collect, days);
        } else if ([metric isEqual:@"heart_rate"]) {
            SRStatistics(@"heart_rate", HKQuantityTypeIdentifierHeartRate, range, perMinute, start, end, group,
                         collect, days);
        } else if ([metric isEqual:@"resting_heart_rate"]) {
            SRStatistics(@"resting_heart_rate", HKQuantityTypeIdentifierRestingHeartRate,
                         HKStatisticsOptionDiscreteAverage, perMinute, start, end, group, collect, days);
        } else if ([metric isEqual:@"weight"]) {
            SRStatistics(@"weight", HKQuantityTypeIdentifierBodyMass, range,
                         [HKUnit gramUnitWithMetricPrefix:HKMetricPrefixKilo], start, end, group, collect, days);
        } else if ([metric isEqual:@"sleep"]) {
            SRSleep(start, end, from, to, group, collect, days);
        } else if ([metric isEqual:@"workouts"]) {
            SRWorkouts(start, end, group, collect, days);
        }
    }
    dispatch_group_notify(group, collect, ^{
        SRDeliver(callback, context, @{@"days" : days});
    });
}
