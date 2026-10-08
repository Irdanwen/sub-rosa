package xyz.carpediem.subrosa.nativebridge

import android.app.Activity
import android.content.Intent
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.aggregate.AggregateMetric
import androidx.health.connect.client.aggregate.AggregationResult
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import app.tauri.annotation.InvokeArg
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.Period
import java.time.ZoneId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

@InvokeArg
class HealthArgs {
    var types: Array<String> = arrayOf()
    var from: String? = null
    var to: String? = null
}

/**
 * Health Connect, read only (ADR-0099). Rust (src/health/native.rs) reads the
 * same answers the iPhone gives:
 *
 *   healthAvailability  {"status":"available"|"unavailable"|"update_required"}
 *   healthRequest       {"ok":true} | {"error":"…"}
 *   healthDaily         {"days":[{"metric","day","value","low","high","samples"}, …]}
 *
 * Only the measures the person picked are asked for, and only read
 * permissions exist in the manifest. A refused measure reads as no data, as
 * on the iPhone. Without the history permission, Health Connect answers the
 * last thirty days before the first grant.
 */
object HealthConnect {
    private val READ = mapOf(
        "steps" to HealthPermission.getReadPermission(StepsRecord::class),
        "sleep" to HealthPermission.getReadPermission(SleepSessionRecord::class),
        "heart_rate" to HealthPermission.getReadPermission(HeartRateRecord::class),
        "resting_heart_rate" to HealthPermission.getReadPermission(RestingHeartRateRecord::class),
        "workouts" to HealthPermission.getReadPermission(ExerciseSessionRecord::class),
        "weight" to HealthPermission.getReadPermission(WeightRecord::class),
    )

    /** Sleep stages that are sleep: light, deep, REM and plain sleeping. */
    private val ASLEEP = setOf(
        SleepSessionRecord.STAGE_TYPE_SLEEPING,
        SleepSessionRecord.STAGE_TYPE_LIGHT,
        SleepSessionRecord.STAGE_TYPE_DEEP,
        SleepSessionRecord.STAGE_TYPE_REM,
    )
    private const val MAX_PAGES = 20

    private fun status(activity: Activity): String =
        when (HealthConnectClient.getSdkStatus(activity)) {
            HealthConnectClient.SDK_AVAILABLE -> "available"
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "update_required"
            else -> "unavailable"
        }

    fun availability(activity: Activity, invoke: Invoke) {
        val status = try {
            status(activity)
        } catch (_: Exception) {
            "unavailable"
        }
        invoke.resolve(JSObject().put("status", status))
    }

    fun request(plugin: SubRosaPlugin, activity: Activity, invoke: Invoke) {
        val args = try {
            invoke.parseArgs(HealthArgs::class.java)
        } catch (_: Exception) {
            invoke.resolve(JSObject().put("error", "invalid_request"))
            return
        }
        if (status(activity) != "available") {
            invoke.resolve(JSObject().put("error", "unavailable"))
            return
        }
        val wanted = args.types.mapNotNull { READ[it] }.toSet()
        if (wanted.isEmpty()) {
            invoke.resolve(JSObject().put("ok", true))
            return
        }
        CoroutineScope(Dispatchers.Main).launch {
            try {
                val granted = HealthConnectClient.getOrCreate(activity).permissionController.getGrantedPermissions()
                if (granted.containsAll(wanted)) {
                    invoke.resolve(JSObject().put("ok", true))
                } else {
                    val intent: Intent = PermissionController.createRequestPermissionResultContract()
                        .createIntent(activity, wanted)
                    plugin.startHealthPermissions(invoke, intent)
                }
            } catch (error: Exception) {
                invoke.resolve(JSObject().put("error", error.message ?: "unavailable"))
            }
        }
    }

    /** The system sheet closed. Whatever was granted is read; the rest reads as nothing. */
    fun answered(invoke: Invoke) {
        invoke.resolve(JSObject().put("ok", true))
    }

    fun daily(activity: Activity, invoke: Invoke) {
        val args = try {
            invoke.parseArgs(HealthArgs::class.java)
        } catch (_: Exception) {
            invoke.resolve(JSObject().put("error", "invalid_request"))
            return
        }
        val from = try {
            LocalDate.parse(args.from)
        } catch (_: Exception) {
            null
        }
        val to = try {
            LocalDate.parse(args.to)
        } catch (_: Exception) {
            null
        }
        if (from == null || to == null || status(activity) != "available") {
            invoke.resolve(JSObject().put("error", "unavailable"))
            return
        }
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val client = HealthConnectClient.getOrCreate(activity)
                val granted = client.permissionController.getGrantedPermissions()
                val start = from.atStartOfDay()
                val end = to.plusDays(1).atStartOfDay()
                val days = JSArray()
                for (type in args.types.distinct()) {
                    if (READ[type]?.let { granted.contains(it) } != true) continue
                    val found = when (type) {
                        "steps" -> perDay(client, start, end, setOf(StepsRecord.COUNT_TOTAL)) { date, result ->
                            result[StepsRecord.COUNT_TOTAL]?.let { day(type, date, it.toDouble()) }
                        }
                        "heart_rate" -> perDay(
                            client, start, end,
                            setOf(HeartRateRecord.BPM_AVG, HeartRateRecord.BPM_MIN, HeartRateRecord.BPM_MAX),
                        ) { date, result ->
                            result[HeartRateRecord.BPM_AVG]?.let {
                                day(
                                    type, date, it.toDouble(),
                                    result[HeartRateRecord.BPM_MIN]?.toDouble(),
                                    result[HeartRateRecord.BPM_MAX]?.toDouble(),
                                )
                            }
                        }
                        "resting_heart_rate" -> perDay(client, start, end, setOf(RestingHeartRateRecord.BPM_AVG)) { date, result ->
                            result[RestingHeartRateRecord.BPM_AVG]?.let { day(type, date, it.toDouble()) }
                        }
                        "weight" -> perDay(
                            client, start, end,
                            setOf(WeightRecord.WEIGHT_AVG, WeightRecord.WEIGHT_MIN, WeightRecord.WEIGHT_MAX),
                        ) { date, result ->
                            result[WeightRecord.WEIGHT_AVG]?.let {
                                day(
                                    type, date, it.inKilograms,
                                    result[WeightRecord.WEIGHT_MIN]?.inKilograms,
                                    result[WeightRecord.WEIGHT_MAX]?.inKilograms,
                                )
                            }
                        }
                        "sleep" -> sleep(client, from, to)
                        "workouts" -> workouts(client, from, to)
                        else -> emptyList()
                    }
                    found.forEach { days.put(it) }
                }
                invoke.resolve(JSObject().put("days", days))
            } catch (error: Exception) {
                invoke.resolve(JSObject().put("error", error.message ?: "read_failed"))
            }
        }
    }

    private fun day(
        metric: String,
        date: LocalDate,
        value: Double,
        low: Double? = null,
        high: Double? = null,
        samples: Int = 0,
    ): JSObject {
        val entry = JSObject()
        entry.put("metric", metric)
        entry.put("day", date.toString())
        entry.put("value", value)
        if (low != null) entry.put("low", low)
        if (high != null) entry.put("high", high)
        entry.put("samples", samples)
        return entry
    }

    /** Health Connect's own daily aggregates, one slice a calendar day. */
    private suspend fun perDay(
        client: HealthConnectClient,
        start: LocalDateTime,
        end: LocalDateTime,
        metrics: Set<AggregateMetric<*>>,
        row: (LocalDate, AggregationResult) -> JSObject?,
    ): List<JSObject> =
        client.aggregateGroupByPeriod(
            AggregateGroupByPeriodRequest(
                metrics = metrics,
                timeRangeFilter = TimeRangeFilter.between(start, end),
                timeRangeSlicer = Period.ofDays(1),
            ),
        ).mapNotNull { group -> row(group.startTime.toLocalDate(), group.result) }

    private fun window(from: LocalDate, to: LocalDate, earlier: Duration): TimeRangeFilter {
        val zone = ZoneId.systemDefault()
        val start: Instant = from.atStartOfDay(zone).toInstant().minus(earlier)
        val end: Instant = to.plusDays(1).atStartOfDay(zone).toInstant()
        return TimeRangeFilter.between(start, end)
    }

    /**
     * Minutes asleep, counted on the morning the night ended. Stages that are
     * not sleep are left out when the source records stages; overlapping
     * sessions from two sources are merged so a night counts once.
     */
    private suspend fun sleep(client: HealthConnectClient, from: LocalDate, to: LocalDate): List<JSObject> {
        val zone = ZoneId.systemDefault()
        val nights = mutableMapOf<LocalDate, MutableList<Pair<Instant, Instant>>>()
        var token: String? = null
        var pages = 0
        do {
            val response = client.readRecords(
                ReadRecordsRequest(
                    SleepSessionRecord::class,
                    timeRangeFilter = window(from, to, Duration.ofHours(18)),
                    pageToken = token,
                ),
            )
            for (session in response.records) {
                val date = session.endTime.atZone(zone).toLocalDate()
                if (date.isBefore(from) || date.isAfter(to)) continue
                val spans = if (session.stages.isEmpty()) {
                    listOf(session.startTime to session.endTime)
                } else {
                    session.stages.filter { it.stage in ASLEEP }.map { it.startTime to it.endTime }
                }
                nights.getOrPut(date) { mutableListOf() }.addAll(spans)
            }
            token = response.pageToken
            pages += 1
        } while (token != null && pages < MAX_PAGES)
        return nights.mapNotNull { (date, spans) ->
            var asleep = Duration.ZERO
            var current: Pair<Instant, Instant>? = null
            var merged = 0
            for (span in spans.sortedBy { it.first }) {
                val open = current
                if (open != null && !span.first.isAfter(open.second)) {
                    if (span.second.isAfter(open.second)) current = open.first to span.second
                    continue
                }
                if (open != null) asleep = asleep.plus(Duration.between(open.first, open.second))
                current = span
                merged += 1
            }
            current?.let { asleep = asleep.plus(Duration.between(it.first, it.second)) }
            if (asleep.isZero || asleep.isNegative) null else day("sleep", date, asleep.toMinutes().toDouble(), samples = merged)
        }
    }

    /** Minutes of exercise and how many sessions, by the day each began. */
    private suspend fun workouts(client: HealthConnectClient, from: LocalDate, to: LocalDate): List<JSObject> {
        val zone = ZoneId.systemDefault()
        val minutes = mutableMapOf<LocalDate, Long>()
        val counts = mutableMapOf<LocalDate, Int>()
        var token: String? = null
        var pages = 0
        do {
            val response = client.readRecords(
                ReadRecordsRequest(
                    ExerciseSessionRecord::class,
                    timeRangeFilter = window(from, to, Duration.ZERO),
                    pageToken = token,
                ),
            )
            for (session in response.records) {
                val date = session.startTime.atZone(zone).toLocalDate()
                minutes[date] = (minutes[date] ?: 0L) + Duration.between(session.startTime, session.endTime).toMinutes()
                counts[date] = (counts[date] ?: 0) + 1
            }
            token = response.pageToken
            pages += 1
        } while (token != null && pages < MAX_PAGES)
        return minutes.map { (date, total) -> day("workouts", date, total.toDouble(), samples = counts[date] ?: 0) }
    }
}
