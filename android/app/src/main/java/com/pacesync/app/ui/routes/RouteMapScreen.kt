package com.pacesync.app.ui.routes

import android.graphics.Color as AndroidColor
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import com.pacesync.app.network.PaceSyncApi
import com.pacesync.app.network.dto.RouteResponse
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Polyline

// Renders a Garmin course's or recorded activity's GPS track as a polyline
// on an OpenStreetMap view (osmdroid — no Google Maps API key/billing
// needed, appropriate for a sideloaded personal app). `courseId` selects
// which backend endpoint to call; `activityId` is accepted for a future
// "view a specific run's route" entry point, not yet wired to any screen.
@Composable
fun RouteMapScreen(api: PaceSyncApi, courseId: String? = null, activityId: String? = null) {
    val context = LocalContext.current
    var route by remember { mutableStateOf<RouteResponse?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(courseId, activityId) {
        Configuration.getInstance().userAgentValue = context.packageName
        runCatching {
            when {
                courseId != null -> api.getCourseRoute(courseId)
                activityId != null -> api.getActivityRoute(activityId)
                else -> null
            }
        }.onSuccess { resp ->
            if (resp == null) {
                error = "No route specified"
            } else if (resp.isSuccessful) {
                route = resp.body()
            } else {
                error = "Failed to load route (${resp.code()})"
            }
        }.onFailure { error = it.message ?: "Network error" }
    }

    when {
        error != null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(error!!, color = MaterialTheme.colorScheme.error)
        }
        route == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        route!!.points.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("No GPS data for this route.")
        }
        else -> AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                MapView(ctx).apply {
                    setTileSource(TileSourceFactory.MAPNIK)
                    setMultiTouchControls(true)
                }
            },
            update = { mapView ->
                val points = route!!.points
                val geoPoints = points.map { GeoPoint(it.lat, it.lng) }
                mapView.overlays.clear()
                mapView.overlays.add(
                    Polyline().apply {
                        setPoints(geoPoints)
                        outlinePaint.color = AndroidColor.parseColor("#34D399") // emerald-400, matches app theme
                        outlinePaint.strokeWidth = 8f
                    },
                )
                val bbox = org.osmdroid.util.BoundingBox.fromGeoPointsSafe(geoPoints)
                mapView.post { mapView.zoomToBoundingBox(bbox, false, 64) }
                mapView.invalidate()
            },
        )
    }
}
