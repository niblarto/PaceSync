package com.pacesync.app.util

import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

// Backend dates are plain "YYYY-MM-DD" strings with no day-of-week info.
// Prefixes the short weekday name, e.g. "2026-10-10" -> "Sat, 2026-10-10".
// Falls back to the raw string if it doesn't parse (defensive — a malformed
// or empty date shouldn't crash the card).
fun withWeekday(isoDate: String): String {
    return runCatching {
        val date = LocalDate.parse(isoDate, DateTimeFormatter.ISO_LOCAL_DATE)
        val weekday = date.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.getDefault())
        "$weekday, $isoDate"
    }.getOrDefault(isoDate)
}
