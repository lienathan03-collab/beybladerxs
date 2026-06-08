package com.rxs.recorder.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rxs.recorder.data.Bey
import com.rxs.recorder.data.RxsApi
import com.rxs.recorder.data.Scoring
import com.rxs.recorder.data.Side
import com.rxs.recorder.data.SoloMatch
import com.rxs.recorder.data.firstAvailBey
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val FINISH_COLORS = mapOf(
    "S" to Color(0xFF3D86C6), "O" to Color(0xFF2E8B57), "B" to Color(0xFFC98D12), "E" to Color(0xFF8E44AD)
)

private data class Snap(
    val p1f: List<List<String>>, val p2f: List<List<String>>,
    val p1u: List<Boolean>, val p2u: List<Boolean>,
    val w1: Boolean, val w2: Boolean, val d1: Int, val d2: Int,
    val warn1: Int, val warn2: Int
)

@Composable
fun ScoreOverlay(match: SoloMatch, eventId: String, api: RxsApi) {
    var tick by remember { mutableIntStateOf(0) }
    var dep1 by remember { mutableIntStateOf(firstAvailBey(match.p1)) }
    var dep2 by remember { mutableIntStateOf(firstAvailBey(match.p2)) }
    var warn1 by remember { mutableIntStateOf(0) }
    var warn2 by remember { mutableIntStateOf(0) }
    var swapped by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    val undo = remember { mutableStateListOf<Snap>() }
    val scope = rememberCoroutineScope()
    var pushJob by remember { mutableStateOf<Job?>(null) }
    val thr = Scoring.threshold(match.round)

    fun decided() = match.p1.win || match.p2.win
    fun depOf(s: Side) = if (s === match.p1) dep1 else dep2
    fun setDepOf(s: Side, i: Int) { if (s === match.p1) dep1 = i else dep2 = i }
    fun warnOf(s: Side) = if (s === match.p1) warn1 else warn2
    fun setWarnOf(s: Side, v: Int) { if (s === match.p1) warn1 = v else warn2 = v }
    fun other(s: Side) = if (s === match.p1) match.p2 else match.p1

    fun schedulePush() {
        pushJob?.cancel()
        pushJob = scope.launch {
            delay(600)
            status = "syncing…"
            api.putMatch(eventId, match, decided())
                .onSuccess { status = "synced" }
                .onFailure { status = "offline — retries on next tap" }
        }
    }

    fun pushSnap() {
        undo.add(
            Snap(
                match.p1.builds.map { it.finishes.toList() }, match.p2.builds.map { it.finishes.toList() },
                match.p1.builds.map { it.usedInCycle }, match.p2.builds.map { it.usedInCycle },
                match.p1.win, match.p2.win, dep1, dep2, warn1, warn2
            )
        )
    }

    fun ensureBey(side: Side, idx: Int) {
        while (side.builds.size <= idx) side.builds.add(Bey("Bey ${side.builds.size + 1}"))
    }

    fun resetCycleIfDone(side: Side) {
        if (side.builds.isNotEmpty() && side.builds.all { it.usedInCycle }) {
            side.builds.forEach { it.usedInCycle = false }
        }
    }

    fun checkWin() {
        if (match.p1.points >= thr) match.p1.win = true
        if (match.p2.points >= thr) match.p2.win = true
    }

    fun apply(winner: Side, type: String) {
        if (decided()) return
        pushSnap()
        val loser = other(winner)
        val wi = depOf(winner); val li = depOf(loser)
        ensureBey(winner, wi); ensureBey(loser, li)
        winner.builds[wi].finishes.add(type); winner.builds[wi].deployed = true; winner.builds[wi].usedInCycle = true
        loser.builds[li].finishes.add("L"); loser.builds[li].deployed = true; loser.builds[li].usedInCycle = true
        resetCycleIfDone(match.p1); resetCycleIfDone(match.p2)
        checkWin()
        warn1 = 0; warn2 = 0 // warnings are per-clash → reset when the beys change
        dep1 = firstAvailBey(match.p1); dep2 = firstAvailBey(match.p2)
        tick++; schedulePush()
    }

    // Warning goes TO [warned]; at 2 the opponent gets +1 (stored as an 'S' point).
    // Per the user's rule this does NOT consume the deck — same beys stay deployed.
    fun addWarning(warned: Side) {
        if (decided()) return
        pushSnap()
        val n = warnOf(warned) + 1
        if (n >= 2) {
            val opp = other(warned)
            val oi = depOf(opp)
            ensureBey(opp, oi)
            opp.builds[oi].finishes.add("S") // +1 point, no usedInCycle / no deploy change
            setWarnOf(warned, 0)
            checkWin()
        } else {
            setWarnOf(warned, n)
        }
        tick++; schedulePush()
    }

    fun undoLast() {
        val s = undo.removeLastOrNull() ?: return
        while (match.p1.builds.size > s.p1f.size) match.p1.builds.removeAt(match.p1.builds.size - 1)
        while (match.p2.builds.size > s.p2f.size) match.p2.builds.removeAt(match.p2.builds.size - 1)
        s.p1f.forEachIndexed { i, f -> if (i < match.p1.builds.size) { match.p1.builds[i].finishes.clear(); match.p1.builds[i].finishes.addAll(f); match.p1.builds[i].usedInCycle = s.p1u.getOrElse(i) { false } } }
        s.p2f.forEachIndexed { i, f -> if (i < match.p2.builds.size) { match.p2.builds[i].finishes.clear(); match.p2.builds[i].finishes.addAll(f); match.p2.builds[i].usedInCycle = s.p2u.getOrElse(i) { false } } }
        match.p1.win = s.w1; match.p2.win = s.w2; dep1 = s.d1; dep2 = s.d2; warn1 = s.warn1; warn2 = s.warn2
        tick++; schedulePush()
    }

    @Suppress("UNUSED_EXPRESSION") tick // subscribe to recomposition

    val left = if (swapped) match.p2 else match.p1
    val right = if (swapped) match.p1 else match.p2

    Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
        SidePanel(
            Modifier.align(Alignment.CenterStart),
            rev = tick,
            side = left, deployed = depOf(left), warnCount = warnOf(left), enabled = !decided(),
            onDeploy = { setDepOf(left, it); tick++ }, onFinish = { apply(left, it) }, onWarn = { addWarning(left) }
        )
        SidePanel(
            Modifier.align(Alignment.CenterEnd),
            rev = tick,
            side = right, deployed = depOf(right), warnCount = warnOf(right), enabled = !decided(),
            onDeploy = { setDepOf(right, it); tick++ }, onFinish = { apply(right, it) }, onWarn = { addWarning(right) }
        )

        // Minimal top bar: round + sync dot only.
        Row(
            Modifier.align(Alignment.TopCenter).padding(top = 36.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Text(match.round, color = Color(0xFF8893A7), fontSize = 11.sp, fontWeight = FontWeight.Bold)
            StatusDot(status)
        }

        // Switch + Undo sit just above the record button.
        Row(
            Modifier.align(Alignment.BottomCenter).padding(bottom = 98.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Chip("⇄ SIDES") { swapped = !swapped; tick++ }
            Chip("UNDO", enabled = undo.isNotEmpty()) { undoLast() }
        }

        if (decided()) {
            Text(
                "🏆 ${if (match.p1.win) match.p1.name else match.p2.name}",
                color = Color(0xFF7FF0A6), fontWeight = FontWeight.Bold, fontSize = 20.sp,
                modifier = Modifier.align(Alignment.Center)
            )
        }
    }
}

@Composable
private fun SidePanel(
    modifier: Modifier,
    rev: Int, // change-counter: forces repaint when the (mutable) match state changes
    side: Side,
    deployed: Int,
    warnCount: Int,
    enabled: Boolean,
    onDeploy: (Int) -> Unit,
    onFinish: (String) -> Unit,
    onWarn: () -> Unit
) {
    @Suppress("UNUSED_EXPRESSION") rev
    Column(
        modifier
            .width(128.dp)
            .background(Color(0xAA05070C), RoundedCornerShape(14.dp))
            .padding(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(5.dp)
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(side.name, color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold, maxLines = 1, modifier = Modifier.weight(1f))
            Box(
                Modifier
                    .background(if (warnCount > 0) Color(0x55E53935) else Color(0x22FFFFFF), RoundedCornerShape(8.dp))
                    .clickable(enabled = enabled) { onWarn() }
                    .padding(horizontal = 6.dp, vertical = 3.dp)
            ) {
                Text(if (warnCount > 0) "⚠$warnCount" else "⚠", color = if (warnCount > 0) Color(0xFFFF8891) else Color(0xFFBFC6D4), fontSize = 11.sp, fontWeight = FontWeight.Bold)
            }
        }
        Text("${side.points}", color = Color.White, fontSize = 28.sp, fontWeight = FontWeight.Bold)

        side.builds.forEachIndexed { i, b ->
            val sel = i == deployed && !b.usedInCycle
            val used = b.usedInCycle
            val pts = b.finishes.filter { it != "L" }.sumOf { Scoring.FINISH_PTS[it] ?: 0 }
            Box(
                Modifier.fillMaxWidth()
                    .background(
                        when { used -> Color(0x22FFFFFF); sel -> Color(0xFF1E4870); else -> Color(0x33FFFFFF) },
                        RoundedCornerShape(8.dp)
                    )
                    .clickable(enabled = enabled && !used) { onDeploy(i) }
                    .padding(vertical = 5.dp, horizontal = 6.dp)
            ) {
                Text(
                    "${if (sel) "▶ " else ""}${b.build.ifBlank { "Bey ${i + 1}" }}  $pts",
                    color = if (used) Color(0x66FFFFFF) else Color.White,
                    textDecoration = if (used) TextDecoration.LineThrough else null,
                    fontSize = 10.sp, maxLines = 1
                )
            }
        }

        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                FinishBtn("S", enabled, Modifier.weight(1f)) { onFinish("S") }
                FinishBtn("O", enabled, Modifier.weight(1f)) { onFinish("O") }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                FinishBtn("B", enabled, Modifier.weight(1f)) { onFinish("B") }
                FinishBtn("E", enabled, Modifier.weight(1f)) { onFinish("E") }
            }
        }
    }
}

@Composable
private fun RowScope.FinishBtn(text: String, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Box(
        modifier
            .background(FINISH_COLORS[text] ?: Color.DarkGray, RoundedCornerShape(8.dp))
            .clickable(enabled = enabled) { onClick() }
            .padding(vertical = 10.dp),
        contentAlignment = Alignment.Center
    ) { Text(text, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 15.sp) }
}

@Composable
private fun StatusDot(status: String?) {
    val color = when {
        status == null -> Color(0x55FFFFFF)
        status.startsWith("synced") || status.startsWith("submitted") -> Color(0xFF7FF0A6)
        status.startsWith("offline") || status.contains("failed") -> Color(0xFFFFC857)
        else -> Color(0xFF8FC7FF)
    }
    val showText = status != null && (status.startsWith("offline") || status.contains("failed"))
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).background(color, CircleShape))
        if (showText) {
            Spacer(Modifier.width(4.dp))
            Text(status!!, color = color, fontSize = 9.sp)
        }
    }
}

@Composable
private fun Chip(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        Modifier
            .background(Color(0xAA05070C), RoundedCornerShape(10.dp))
            .border(1.dp, Color(0x55FFFFFF), RoundedCornerShape(10.dp))
            .clickable(enabled = enabled) { onClick() }
            .padding(vertical = 6.dp, horizontal = 12.dp)
    ) {
        Text(label, color = if (enabled) Color.White else Color(0x66FFFFFF), fontSize = 11.sp, fontWeight = FontWeight.Bold)
    }
}
