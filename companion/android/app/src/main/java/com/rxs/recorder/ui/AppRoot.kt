package com.rxs.recorder.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rxs.recorder.data.EventSummary
import com.rxs.recorder.data.RxsApi
import com.rxs.recorder.data.Settings
import com.rxs.recorder.data.SoloMatch
import com.rxs.recorder.data.normalizeServerUrl
import kotlinx.coroutines.launch

private sealed class Route {
    object Setup : Route()
    object Events : Route()
    data class Matches(val event: EventSummary) : Route()
    data class Record(val event: EventSummary, val match: SoloMatch) : Route()
}

@Composable
fun AppRoot() {
    val context = LocalContext.current
    val settings = remember { Settings(context) }
    val api = remember { RxsApi(settings) }
    var route by remember { mutableStateOf<Route>(if (settings.isConfigured) Route.Events else Route.Setup) }

    when (val r = route) {
        is Route.Setup -> SetupScreen(settings) { route = Route.Events }
        is Route.Events -> EventPickerScreen(
            api,
            onPick = { route = Route.Matches(it) },
            onSettings = { route = Route.Setup }
        )
        is Route.Matches -> MatchPickerScreen(
            api, r.event,
            onPick = { route = Route.Record(r.event, it) },
            onBack = { route = Route.Events }
        )
        is Route.Record -> CameraScreen(
            match = r.match, eventId = r.event.id, api = api,
            onBack = { route = Route.Matches(r.event) }
        )
    }
}

@Composable
private fun SetupScreen(settings: Settings, onDone: () -> Unit) {
    val api = remember { RxsApi(settings) }
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf(settings.serverUrl.ifBlank { "https://beybladerxs.pages.dev" }) }
    var user by remember { mutableStateOf(settings.adminUser) }
    var pass by remember { mutableStateOf(settings.adminPass) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    Column(
        Modifier.fillMaxSize().background(Color.Black).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("RXS Recorder — connect", color = Color.White, fontSize = 20.sp)
        OutlinedTextField(url, { url = it }, label = { Text("Server URL (your live site)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(user, { user = it }, label = { Text("Admin username") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(
            pass, { pass = it }, label = { Text("Admin password") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth()
        )
        error?.let { Text(it, color = Color(0xFFFF8891)) }
        Button(
            enabled = !busy && url.isNotBlank() && user.isNotBlank() && pass.isNotBlank(),
            onClick = {
                busy = true; error = null
                val u = normalizeServerUrl(url)
                url = u
                scope.launch {
                    api.login(u, user.trim(), pass).onSuccess {
                        settings.serverUrl = u; settings.adminUser = user.trim(); settings.adminPass = pass
                        busy = false; onDone()
                    }.onFailure { busy = false; error = it.message ?: "Login failed" }
                }
            }
        ) { Text(if (busy) "Connecting…" else "Connect") }
        Text("Stored on this device only. Admin login is required to write scores.", color = Color(0xFF8893A7), fontSize = 11.sp)
    }
}

@Composable
private fun EventPickerScreen(api: RxsApi, onPick: (EventSummary) -> Unit, onSettings: () -> Unit) {
    var reload by remember { mutableStateOf(0) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var events by remember { mutableStateOf<List<EventSummary>>(emptyList()) }

    LaunchedEffect(reload) {
        loading = true; error = null
        api.getEvents().onSuccess { events = it; loading = false }.onFailure { error = it.message; loading = false }
    }

    Column(Modifier.fillMaxSize().background(Color.Black).padding(16.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Pick event", color = Color.White, fontSize = 20.sp, modifier = Modifier.weight(1f))
            TextButton(onClick = { reload++ }) { Text("Refresh") }
            TextButton(onClick = onSettings) { Text("Settings") }
        }
        Spacer(Modifier.width(8.dp))
        when {
            loading -> Center { CircularProgressIndicator(color = Color.White) }
            error != null -> Center {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Error: $error", color = Color(0xFFFF8891))
                    Button(onClick = { reload++ }) { Text("Retry") }
                }
            }
            events.isEmpty() -> Center { Text("No events found.", color = Color.White) }
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(events) { ev ->
                    Row(
                        Modifier.fillMaxWidth().clickable { onPick(ev) }
                            .background(Color(0xFF11151C)).padding(14.dp)
                    ) {
                        Text(ev.title, color = Color.White, fontSize = 16.sp, modifier = Modifier.weight(1f))
                        Text(ev.type ?: "1v1", color = Color(0xFF8893A7))
                    }
                }
            }
        }
    }
}

@Composable
private fun MatchPickerScreen(api: RxsApi, event: EventSummary, onPick: (SoloMatch) -> Unit, onBack: () -> Unit) {
    var reload by remember { mutableStateOf(0) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var matches by remember { mutableStateOf<List<SoloMatch>>(emptyList()) }

    LaunchedEffect(reload) {
        loading = true; error = null
        api.getEventState(event.id)
            .onSuccess { matches = it.matches; loading = false }
            .onFailure { error = it.message; loading = false }
    }

    Column(Modifier.fillMaxSize().background(Color.Black).padding(16.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("‹ Events") }
            Text(event.title, color = Color.White, fontSize = 18.sp, modifier = Modifier.weight(1f))
            TextButton(onClick = { reload++ }) { Text("Refresh") }
        }
        when {
            loading -> Center { CircularProgressIndicator(color = Color.White) }
            error != null -> Center {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Error: $error", color = Color(0xFFFF8891))
                    Button(onClick = { reload++ }) { Text("Retry") }
                }
            }
            matches.isEmpty() -> Center { Text("No 1v1 matches yet.\n(Create-at-stadium coming next.)", color = Color.White) }
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(matches) { m ->
                    Row(
                        Modifier.fillMaxWidth().clickable { onPick(m) }
                            .background(Color(0xFF11151C)).padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(m.label, color = Color.White, fontSize = 15.sp, modifier = Modifier.weight(1f))
                        Text(
                            if (m.submitted) "submitted" else "${m.p1.points}–${m.p2.points}",
                            color = if (m.submitted) Color(0xFF7FF0A6) else Color(0xFF8FC7FF)
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun Center(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { content() }
}
