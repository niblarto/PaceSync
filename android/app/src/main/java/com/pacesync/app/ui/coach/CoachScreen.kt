package com.pacesync.app.ui.coach

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import android.content.Context
import androidx.compose.ui.platform.LocalContext
import com.pacesync.app.R
import com.pacesync.app.network.CoachApi
import com.pacesync.app.ui.common.ScrollingBackground
import com.pacesync.app.network.PaceSyncApi
import com.pacesync.app.network.dto.CoachMemory
import com.pacesync.app.network.dto.CoachMessage
import com.pacesync.app.network.dto.CoachReport
import com.pacesync.app.network.dto.CoachSendRequest
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

// Coach tab — the same conversation, weekly reports and memory as the web
// Coach page (app/coach). Chat answers come from whichever AI Settings ->
// Coach picked on the web.

private val EMERALD = Color(0xFF10B981)
private val VIOLET = Color(0xFFA78BFA)

private val STARTERS = listOf(
    "How did my training go this week?",
    "Review my last run against the plan.",
    "Given my recovery, should I adjust my next session?",
    "Am I on track for my next race?",
)

private fun timeLabel(iso: String): String = runCatching {
    val t = OffsetDateTime.parse(iso).atZoneSameInstant(ZoneId.systemDefault())
    val fmt = if (t.toLocalDate() == LocalDate.now()) "HH:mm" else "EEE d MMM HH:mm"
    t.format(DateTimeFormatter.ofPattern(fmt))
}.getOrDefault("")

private fun weekLabel(weekStart: String): String = runCatching {
    val d = LocalDate.parse(weekStart)
    val f = DateTimeFormatter.ofPattern("d MMM")
    "${d.format(f)} – ${d.plusDays(6).format(f)}"
}.getOrDefault(weekStart)

private fun memoryDate(dateId: Int): String = runCatching {
    LocalDate.parse(dateId.toString(), DateTimeFormatter.BASIC_ISO_DATE).format(DateTimeFormatter.ofPattern("EEE d MMM"))
}.getOrDefault(dateId.toString())

@Composable
fun CoachScreen(coachApi: CoachApi, api: PaceSyncApi) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var tab by remember { mutableIntStateOf(0) }
    // "Discuss with coach" on the Report tab hands a message to the Chat tab.
    var queued by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var refreshMsg by remember { mutableStateOf<String?>(null) }
    // The image scrolls with whichever tab's list is being dragged (nested scroll), as on the other tabs.
    ScrollingBackground(imageRes = R.drawable.apk_background, dim = 0.82f) { bgModifier ->
    Column(bgModifier.fillMaxSize()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TabRow(selectedTabIndex = tab, modifier = Modifier.weight(1f), containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.88f)) {
                listOf("Chat", "Report", "Memory").forEachIndexed { i, label ->
                    Tab(selected = tab == i, onClick = { tab = i }, text = { Text(label) })
                }
            }
            TextButton(onClick = {
                refreshing = true
                refreshMsg = null
                scope.launch {
                    val ok = runCatching { coachApi.refreshData().isSuccessful }.getOrDefault(false)
                    refreshMsg = if (ok) "Coach data refreshed" else "Server refresh failed"
                    refreshing = false
                }
            }, enabled = !refreshing) {
                if (refreshing) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) else Text("↻")
            }
        }
        refreshMsg?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary, modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp))
        }
        when (tab) {
            0 -> ChatTab(coachApi, queued) { queued = null }
            1 -> ReportTab(coachApi) { msg -> queued = msg; tab = 0 }
            else -> MemoryTab(coachApi)
        }
    }
    }
}

@Composable
private fun ChatTab(coachApi: CoachApi, queued: String?, onQueuedTaken: () -> Unit) {
    val scope = rememberCoroutineScope()
    var messages by remember { mutableStateOf<List<CoachMessage>?>(null) }
    var model by remember { mutableStateOf("") }
    var input by remember { mutableStateOf("") }
    var pending by remember { mutableStateOf<String?>(null) }
    var elapsed by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmNew by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()

    LaunchedEffect(Unit) {
        val resp = runCatching { coachApi.getChat() }.getOrNull()
        if (resp?.isSuccessful == true) {
            messages = resp.body()?.messages ?: emptyList()
            model = resp.body()?.model ?: ""
        } else {
            messages = emptyList()
            error = resp?.let { CoachApi.errorText(it) } ?: "Couldn't reach PaceSync"
        }
    }
    LaunchedEffect(pending) {
        if (pending == null) return@LaunchedEffect
        elapsed = 0
        while (true) { delay(1000); elapsed++ }
    }
    val count = (messages?.size ?: 0) + if (pending != null) 2 else 0
    LaunchedEffect(count) { if (count > 0) listState.animateScrollToItem(count - 1) }

    fun send(text: String, web: Boolean = false) {
        val msg = text.trim()
        if (msg.isEmpty() || pending != null) return
        error = null
        pending = msg
        input = ""
        scope.launch {
            val resp = runCatching { coachApi.send(CoachSendRequest(msg, web)) }
            val r = resp.getOrNull()
            val body = r?.body()
            if (r?.isSuccessful == true && body?.userMessage != null && body.reply != null) {
                messages = (messages ?: emptyList()) + body.userMessage + body.reply
                body.reply.model?.let { model = it }
            } else {
                error = r?.let { CoachApi.errorText(it) } ?: (resp.exceptionOrNull()?.message ?: "The coach couldn't reply")
                input = msg
            }
            pending = null
        }
    }

    LaunchedEffect(queued, messages) {
        if (queued != null && messages != null) { send(queued); onQueuedTaken() }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        Row(
            Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface.copy(alpha = 0.88f)).padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(model, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary, modifier = Modifier.weight(1f))
            if (confirmNew) {
                TextButton(onClick = {
                    confirmNew = false
                    scope.launch { runCatching { coachApi.newConversation() }; messages = emptyList(); error = null }
                }) { Text("Confirm", color = Color(0xFFF87171)) }
                TextButton(onClick = { confirmNew = false }) { Text("Cancel") }
            } else {
                TextButton(onClick = { confirmNew = true }, enabled = !messages.isNullOrEmpty() && pending == null) { Text("New conversation") }
            }
        }

        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (messages == null) item { Text("Loading…", color = MaterialTheme.colorScheme.secondary) }
            if (messages?.isEmpty() == true && pending == null) {
                item {
                    Column(Modifier.fillMaxWidth().padding(top = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            "Ask about your training. The coach reads your Garmin runs, recovery, Runna plan and races before every answer.",
                            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.secondary,
                        )
                        STARTERS.forEach { s -> SuggestionChip(onClick = { send(s) }, label = { Text(s) }) }
                    }
                }
            }
            items(messages ?: emptyList(), key = { it.id }) { m -> Bubble(m) }
            if (pending != null) {
                item { Bubble(CoachMessage(-1, "user", pending!!, "")) }
                item {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = EMERALD)
                        Text("Coach is reviewing your data… ${elapsed}s", color = MaterialTheme.colorScheme.secondary)
                    }
                }
            }
        }

        error?.let { Text(it, color = Color(0xFFF87171), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 12.dp)) }

        Row(
            Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface.copy(alpha = 0.88f)).padding(8.dp),
            verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                placeholder = { Text("Ask your coach…") },
                modifier = Modifier.weight(1f),
                maxLines = 5,
            )
            OutlinedButton(
                onClick = { send(input, web = true) },
                enabled = input.isNotBlank() && pending == null,
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 10.dp),
            ) { Text("🌐") }
            Button(
                onClick = { send(input) },
                enabled = input.isNotBlank() && pending == null,
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF059669), contentColor = Color.White),
            ) { Text("Send") }
        }
    }
}

@Composable
private fun Bubble(m: CoachMessage) {
    val mine = m.role == "user"
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        Column(
            Modifier
                .widthIn(max = 340.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(if (mine) Color(0x4010B981) else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.88f))
                .padding(12.dp),
        ) {
            if (mine) Text(m.content, style = MaterialTheme.typography.bodyMedium) else CoachMarkdown(m.content)
            val meta = listOfNotNull(
                timeLabel(m.createdAt).ifEmpty { null },
                m.model,
                if (m.recalled.isNotEmpty()) "🧠 recalled ${m.recalled.size}" else null,
            ).joinToString(" · ")
            if (meta.isNotEmpty()) {
                Text(meta, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary, modifier = Modifier.padding(top = 4.dp))
            }
        }
    }
}

@Composable
private fun ReportTab(coachApi: CoachApi, onDiscuss: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var reports by remember { mutableStateOf<List<CoachReport>?>(null) }
    var idx by remember { mutableIntStateOf(0) }
    var writing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var weekMenu by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<Int?>(null) }

    suspend fun load() {
        val body = runCatching { coachApi.getReports().body() }.getOrNull() ?: return
        val firstBefore = reports?.firstOrNull()?.id
        reports = body.reports
        if (body.reports.firstOrNull()?.id != firstBefore || idx >= body.reports.size) idx = 0
        if (writing && !body.writing && body.error != null) error = body.error
        writing = body.writing
    }
    LaunchedEffect(Unit) { load() }
    LaunchedEffect(writing) { while (writing) { delay(5000); load() } }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val list = reports.orEmpty()
            if (list.size > 1) {
                Box {
                    OutlinedButton(onClick = { weekMenu = true }) { Text(weekLabel(list[idx].weekStart)) }
                    DropdownMenu(expanded = weekMenu, onDismissRequest = { weekMenu = false }) {
                        list.forEachIndexed { i, r -> DropdownMenuItem(text = { Text(weekLabel(r.weekStart)) }, onClick = { idx = i; weekMenu = false }) }
                    }
                }
            }
            Spacer(Modifier.weight(1f))
            OutlinedButton(onClick = {
                error = null
                scope.launch {
                    val ok = runCatching { coachApi.writeReport().isSuccessful }.getOrDefault(false)
                    if (ok) writing = true else error = "Couldn't start the report"
                }
            }, enabled = !writing) { Text(if (writing) "Writing…" else "Write now") }
        }
        if (writing) Text("The coach is writing this week's report — it'll appear here.", color = VIOLET, style = MaterialTheme.typography.bodySmall)
        error?.let { Text(it, color = Color(0xFFF87171), style = MaterialTheme.typography.bodySmall) }
        when {
            reports == null -> Text("Loading…", color = MaterialTheme.colorScheme.secondary)
            reports!!.isEmpty() -> Text(
                "No reports yet. The coach writes one every Sunday evening, or tap Write now.",
                color = MaterialTheme.colorScheme.secondary,
            )
            else -> {
                val r = reports!![idx.coerceIn(0, reports!!.size - 1)]
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "Week of ${weekLabel(r.weekStart)} · written ${timeLabel(r.createdAt)}${r.model?.let { " · $it" } ?: ""}",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary,
                        modifier = Modifier.weight(1f),
                    )
                    if (confirmDelete == r.id) {
                        TextButton(onClick = {
                            confirmDelete = null
                            scope.launch {
                                val resp = runCatching { coachApi.deleteReport(r.id) }.getOrNull()
                                if (resp?.isSuccessful == true) {
                                    idx = 0
                                    load()
                                } else {
                                    error = resp?.let { CoachApi.errorText(it) } ?: "Couldn't delete the report"
                                }
                            }
                        }) { Text("Delete", color = Color(0xFFF87171)) }
                        TextButton(onClick = { confirmDelete = null }) { Text("Cancel") }
                    } else {
                        TextButton(onClick = { confirmDelete = r.id }, enabled = !writing) {
                            Text("🗑 Delete", color = MaterialTheme.colorScheme.secondary)
                        }
                    }
                }
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.88f))) {
                    Box(Modifier.padding(12.dp)) { CoachMarkdown(r.content) }
                }
                if (idx == 0) {
                    Button(
                        onClick = { onDiscuss("Let's go through the weekly report for ${weekLabel(r.weekStart)}.") },
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF059669), contentColor = Color.White),
                    ) { Text("💬 Discuss with coach") }
                }
            }
        }
    }
}

@Composable
private fun MemoryTab(coachApi: CoachApi) {
    val scope = rememberCoroutineScope()
    var memories by remember { mutableStateOf<List<CoachMemory>?>(null) }
    var summarising by remember { mutableStateOf(false) }
    var confirmForget by remember { mutableStateOf<String?>(null) }

    suspend fun load() {
        val body = runCatching { coachApi.getMemories().body() }.getOrNull()
        memories = body?.memories ?: memories ?: emptyList()
        summarising = body?.summarising == true
    }
    LaunchedEffect(Unit) { load() }
    LaunchedEffect(summarising) { while (summarising) { delay(4000); load() } }

    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Text(
                "Each finished conversation and weekly report is summarised here. The coach recalls the 3 most relevant from the last 30 days.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary, modifier = Modifier.padding(top = 10.dp),
            )
        }
        if (summarising) item { Text("Saving the last conversation to memory…", color = VIOLET, style = MaterialTheme.typography.bodySmall) }
        if (memories?.isEmpty() == true) item { Text("Nothing saved yet.", color = MaterialTheme.colorScheme.secondary) }
        items(memories ?: emptyList(), key = { it.id }) { m ->
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.88f))) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(memoryDate(m.dateId), style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
                        if (confirmForget == m.id) {
                            TextButton(onClick = {
                                confirmForget = null
                                scope.launch { runCatching { coachApi.forgetMemory(m.id) }; load() }
                            }) { Text("Forget", color = Color(0xFFF87171)) }
                            TextButton(onClick = { confirmForget = null }) { Text("Cancel") }
                        } else {
                            TextButton(onClick = { confirmForget = m.id }) { Text("✕", color = MaterialTheme.colorScheme.secondary) }
                        }
                    }
                    Text(m.summary, style = MaterialTheme.typography.bodySmall)
                    if (m.keywords.isNotEmpty()) {
                        Text(m.keywords.joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary)
                    }
                }
            }
        }
        item { Spacer(Modifier.padding(8.dp)) }
    }
}
