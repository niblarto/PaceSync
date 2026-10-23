package com.pacesync.app.ui.coach

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp

// Just enough Markdown for coach replies: **bold**, *italic*, bullets,
// numbered lists and headings.

private val INLINE = Regex("""\[([^\]]+)\]\((https?://[^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|`([^`]+)`""")

fun inlineMarkdown(text: String): AnnotatedString = buildAnnotatedString {
    var last = 0
    for (m in INLINE.findAll(text)) {
        append(text.substring(last, m.range.first))
        when {
            // [title](url): tappable link (web search sources)
            m.groupValues[1].isNotEmpty() -> withLink(
                LinkAnnotation.Url(m.groupValues[2], TextLinkStyles(SpanStyle(color = Color(0xFF7DD3FC), textDecoration = TextDecoration.Underline))),
            ) { append(m.groupValues[1]) }
            m.groupValues[3].isNotEmpty() -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = Color.White)) { append(m.groupValues[3]) }
            m.groupValues[4].isNotEmpty() -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(m.groupValues[4]) }
            else -> withStyle(SpanStyle(color = Color(0xFF6EE7B7))) { append(m.groupValues[5]) }
        }
        last = m.range.last + 1
    }
    append(text.substring(last))
}

@Composable
fun CoachMarkdown(text: String, color: Color = MaterialTheme.colorScheme.onSurface) {
    val style = MaterialTheme.typography.bodyMedium
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for (raw in text.replace("\r", "").split("\n")) {
            val line = raw.trimEnd()
            if (line.isBlank()) continue
            val heading = Regex("""^#{1,4}\s+(.*)""").find(line)
            val bullet = Regex("""^(\s*)([-*•]|\d+[.)])\s+(.*)""").find(line)
            when {
                heading != null -> Text(
                    inlineMarkdown(heading.groupValues[1]),
                    style = style.copy(fontWeight = FontWeight.SemiBold), color = Color.White,
                    modifier = Modifier.padding(top = 4.dp),
                )
                bullet != null -> {
                    val indent = if (bullet.groupValues[1].length >= 2) 16.dp else 0.dp
                    val marker = bullet.groupValues[2].let { if (it.first().isDigit()) it else "•" }
                    Row(Modifier.padding(start = indent)) {
                        Text(marker, style = style, color = color, modifier = Modifier.width(18.dp))
                        Text(inlineMarkdown(bullet.groupValues[3]), style = style, color = color)
                    }
                }
                else -> Text(inlineMarkdown(line), style = style, color = color)
            }
        }
    }
}
