package com.rxs.recorder.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

// ─────────────────────────────────────────────────────────────────────────────
// Scoring rules — mirror eventmanager.html exactly (FINISH_PTS, thresholds).
// ─────────────────────────────────────────────────────────────────────────────
object Scoring {
    val FINISH_PTS = mapOf("S" to 1, "O" to 2, "E" to 3, "B" to 2, "L" to 0)
    fun points(builds: List<Bey>): Int =
        builds.sumOf { b -> b.finishes.filter { it != "L" }.sumOf { FINISH_PTS[it] ?: 0 } }
    fun threshold(round: String): Int = when (round) { "F" -> 7; "SF" -> 5; else -> 4 }
}

// ─────────────────────────────────────────────────────────────────────────────
// Models (1v1 / solo)
// ─────────────────────────────────────────────────────────────────────────────
data class Bey(var build: String, val finishes: MutableList<String> = mutableListOf(), var deployed: Boolean = false)

data class Side(
    val player: String,
    val entryId: String?,
    val displayLabel: String?,
    val builds: MutableList<Bey> = mutableListOf(),
    var win: Boolean = false
) {
    val name: String get() = displayLabel ?: player
    val points: Int get() = Scoring.points(builds)
}

data class SoloMatch(
    val sid: String,
    val round: String,
    val p1: Side,
    val p2: Side,
    var submitted: Boolean
) {
    val label: String get() = "$round · ${p1.name} vs ${p2.name}"
}

data class Joiner(val entryId: String?, val name: String, val type: String?, val entryType: String?)
data class EventSummary(val id: String, val title: String, val type: String?, val joiners: List<Joiner>)
data class EventState(val matches: List<SoloMatch>, val buildsByPlayer: Map<String, List<String>>)

// ─────────────────────────────────────────────────────────────────────────────
// Settings — PROTOTYPE: plain SharedPreferences. Admin creds are NOT encrypted;
// hardening (Keystore / scoped token) is a TODO before real deployment.
// ─────────────────────────────────────────────────────────────────────────────
class Settings(context: Context) {
    private val p = context.getSharedPreferences("rxs", Context.MODE_PRIVATE)
    var serverUrl: String
        get() = p.getString("url", "") ?: ""
        set(v) { p.edit().putString("url", v).apply() }
    var adminUser: String
        get() = p.getString("user", "") ?: ""
        set(v) { p.edit().putString("user", v).apply() }
    var adminPass: String
        get() = p.getString("pass", "") ?: ""
        set(v) { p.edit().putString("pass", v).apply() }
    val isConfigured: Boolean get() = serverUrl.isNotBlank() && adminUser.isNotBlank() && adminPass.isNotBlank()
}

/**
 * Normalize a user-entered server URL so a typo can't cause a redirect that
 * downgrades POST→GET (which the API answers with 405). Forces https, drops any
 * path/trailing slash, leaving just scheme://host[:port].
 */
fun normalizeServerUrl(raw: String): String {
    var s = raw.trim()
    if (s.isEmpty()) return s
    s = when {
        s.startsWith("https://") -> s
        s.startsWith("http://") -> "https://" + s.removePrefix("http://")
        else -> "https://$s"
    }
    val schemeEnd = s.indexOf("://") + 3
    val slash = s.indexOf('/', schemeEnd)
    if (slash != -1) s = s.substring(0, slash)
    return s
}

// ─────────────────────────────────────────────────────────────────────────────
// API — endpoints/contracts from docs/rxs-companion/phase1-eventmanager-api-report.md
// ─────────────────────────────────────────────────────────────────────────────
class RxsApi(private val settings: Settings) {
    private fun base() = settings.serverUrl.trimEnd('/')

    suspend fun login(url: String, user: String, pass: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val (code, text) = req(
                "${url.trimEnd('/')}/api/login", "POST",
                JSONObject().put("username", user).put("password", pass).toString()
            )
            if (code != 200) error(errMsg(text, code))
        }
    }

    suspend fun getEvents(): Result<List<EventSummary>> = withContext(Dispatchers.IO) {
        runCatching {
            val (code, text) = req("${base()}/api/events", "GET", null)
            if (code != 200) error("HTTP $code")
            parseEvents(JSONObject(text).optJSONArray("events") ?: JSONArray())
        }
    }

    suspend fun getEventState(eventId: String): Result<EventState> = withContext(Dispatchers.IO) {
        runCatching {
            val (code, text) = req(
                "${base()}/api/beyresults?eventId=${enc(eventId)}&_t=${System.currentTimeMillis()}", "GET", null
            )
            if (code != 200) error("HTTP $code")
            parseEventState(JSONObject(text))
        }
    }

    /** Push this match's two rows (merge mode). `submitted` marks the result final. */
    suspend fun putMatch(eventId: String, m: SoloMatch, submitted: Boolean): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val body = buildPutBody(eventId, m, submitted, settings.adminUser, settings.adminPass)
                val (code, text) = req("${base()}/api/beyresults", "PUT", body)
                if (code != 200) error(errMsg(text, code))
            }
        }

    private fun req(urlStr: String, method: String, body: String?): Pair<Int, String> {
        val c = URL(urlStr).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 15000
        c.readTimeout = 20000
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        }
        val code = c.responseCode
        val stream = if (code in 200..299) c.inputStream else (c.errorStream ?: c.inputStream)
        val text = stream.bufferedReader().use { it.readText() }
        c.disconnect()
        return code to text
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
    private fun errMsg(text: String, code: Int): String =
        runCatching { JSONObject(text).optString("error") }.getOrNull()?.takeIf { it.isNotBlank() } ?: "HTTP $code"
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────
private fun parseEvents(arr: JSONArray): List<EventSummary> = buildList {
    for (i in 0 until arr.length()) {
        val o = arr.optJSONObject(i) ?: continue
        val joiners = mutableListOf<Joiner>()
        o.optJSONArray("joiners")?.let { ja ->
            for (j in 0 until ja.length()) {
                val jo = ja.optJSONObject(j) ?: continue
                joiners.add(
                    Joiner(
                        entryId = jo.optString("entryId").ifBlank { null },
                        name = jo.optString("displayLabel").ifBlank { jo.optString("name") },
                        type = jo.optString("type").ifBlank { null },
                        entryType = jo.optString("entryType").ifBlank { null }
                    )
                )
            }
        }
        add(
            EventSummary(
                id = o.optString("id"),
                title = o.optString("title").ifBlank { "(untitled)" },
                type = o.optString("type").ifBlank { null },
                joiners = joiners
            )
        )
    }
}

private fun parseEventState(o: JSONObject): EventState {
    val rows = o.optJSONArray("beyResults") ?: JSONArray()

    val buildsByPlayer = mutableMapOf<String, List<String>>()
    o.optJSONObject("builds")?.let { b ->
        val keys = b.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            val a = b.optJSONArray(k) ?: continue
            buildsByPlayer[k] = (0 until a.length()).map { a.optString(it) }
        }
    }

    val order = mutableListOf<String>()
    val groups = linkedMapOf<String, MutableList<JSONObject>>()
    for (i in 0 until rows.length()) {
        val r = rows.optJSONObject(i) ?: continue
        if (r.optString("team").isNotBlank()) continue // solo only for now
        val sid = r.optString("_matchSid")
        if (sid.isBlank()) continue
        groups.getOrPut(sid) { order.add(sid); mutableListOf() }.add(r)
    }

    val matches = mutableListOf<SoloMatch>()
    for (sid in order) {
        val g = groups[sid] ?: continue
        if (g.size < 2) continue
        matches.add(
            SoloMatch(
                sid = sid,
                round = g[0].optString("round").ifBlank { "?" },
                p1 = sideFrom(g[0]),
                p2 = sideFrom(g[1]),
                submitted = g.any { it.optBoolean("_submitted", false) }
            )
        )
    }
    return EventState(matches, buildsByPlayer)
}

private fun sideFrom(r: JSONObject): Side {
    val builds = mutableListOf<Bey>()
    r.optJSONArray("builds")?.let { ba ->
        for (i in 0 until ba.length()) {
            val bo = ba.optJSONObject(i) ?: continue
            val fin = mutableListOf<String>()
            bo.optJSONArray("finishes")?.let { fa -> for (k in 0 until fa.length()) fin.add(fa.optString(k)) }
            builds.add(Bey(bo.optString("build"), fin, bo.optBoolean("deployed", false)))
        }
    }
    return Side(
        player = r.optString("player"),
        entryId = r.optString("entryId").ifBlank { null },
        displayLabel = r.optString("displayLabel").ifBlank { null },
        builds = builds,
        win = r.optBoolean("win", false)
    )
}

// First bey with no finishes yet (the next fresh deploy); 0 if none/empty.
fun firstAvailBey(side: Side): Int {
    for (i in side.builds.indices) if (side.builds[i].finishes.isEmpty()) return i
    return 0
}

private fun rowJson(side: Side, round: String, sid: String, submitted: Boolean): JSONObject {
    val builds = JSONArray()
    for (b in side.builds) {
        val fa = JSONArray()
        b.finishes.forEach { fa.put(it) }
        builds.put(JSONObject().put("build", b.build).put("finishes", fa).put("deployed", b.deployed))
    }
    val o = JSONObject()
        .put("player", side.player)
        .put("round", round)
        .put("builds", builds)
        .put("pointsTotal", side.points)
        .put("win", side.win)
        .put("_matchSid", sid)
    side.entryId?.let { o.put("entryId", it) }
    side.displayLabel?.let { o.put("displayLabel", it) }
    if (submitted) o.put("_submitted", true)
    return o
}

private fun buildPutBody(eventId: String, m: SoloMatch, submitted: Boolean, user: String, pass: String): String {
    val rows = JSONArray()
        .put(rowJson(m.p1, m.round, m.sid, submitted))
        .put(rowJson(m.p2, m.round, m.sid, submitted))
    val builds = JSONObject()
        .put(m.p1.player, JSONArray().also { arr -> m.p1.builds.forEach { arr.put(it.build) } })
        .put(m.p2.player, JSONArray().also { arr -> m.p2.builds.forEach { arr.put(it.build) } })
    return JSONObject()
        .put("adminUsername", user)
        .put("adminPassword", pass)
        .put("eventId", eventId)
        .put("beyResults", rows)
        .put("builds", builds)
        .put("mergeMode", true)
        .put("revivedSids", JSONArray())
        .toString()
}
