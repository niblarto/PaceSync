package com.pacesync.app.network.dto

import kotlinx.serialization.Serializable

// Coach (app/api/coach/*) and post-run feedback (app/api/run-feedback).

@Serializable
data class CoachMessage(
    val id: Int,
    val role: String, // "user" | "assistant"
    val content: String,
    val createdAt: String,
    val model: String? = null,
    val recalled: List<String> = emptyList(),
)

@Serializable
data class CoachChatResponse(val messages: List<CoachMessage> = emptyList(), val model: String? = null)

@Serializable
data class CoachSendRequest(val message: String)

@Serializable
data class CoachSendResponse(val userMessage: CoachMessage? = null, val reply: CoachMessage? = null, val error: String? = null)

@Serializable
data class CoachMemory(
    val id: String,
    val dateId: Int,
    val summary: String,
    val keywords: List<String> = emptyList(),
    val createdAt: String,
)

@Serializable
data class CoachMemoryResponse(val memories: List<CoachMemory> = emptyList(), val summarising: Boolean = false)

@Serializable
data class CoachReport(
    val id: Int,
    val weekStart: String,
    val createdAt: String,
    val content: String,
    val model: String? = null,
)

@Serializable
data class CoachReportsResponse(val reports: List<CoachReport> = emptyList(), val writing: Boolean = false, val error: String? = null)

@Serializable
data class RunFeedbackDto(
    val date: String,
    val title: String,
    val effort: Int? = null,
    val feel: Int? = null,
    val notes: String? = null,
)

@Serializable
data class RunFeedbackResponse(val feedback: RunFeedbackDto? = null)

@Serializable
data class RunFeedbackRequest(val date: String, val title: String, val effort: Int?, val feel: Int?, val notes: String?)
