package com.pacesync.app.ui.routes

import android.graphics.Color as AndroidColor
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import com.pacesync.app.network.dto.RoutePoint
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.BoundingBox
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Polyline

// Shared polyline-on-OSM renderer, factored out of RouteMapScreen so the
// activity-detail screen (ui/detail/ActivityDetailScreen.kt) can embed the
// same map without duplicating the osmdroid setup/Polyline/bounding-box
// logic. Pass an empty list to get the "No GPS data" message.
@Composable
fun RouteMapView(points: List<RoutePoint>, modifier: Modifier = Modifier.fillMaxSize()) {
    val context = LocalContext.current
    if (points.isEmpty()) {
        Box(modifier, contentAlignment = Alignment.Center) {
            Text("No GPS data for this route.", color = MaterialTheme.colorScheme.secondary)
        }
        return
    }
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            Configuration.getInstance().userAgentValue = context.packageName
            MapView(ctx).apply {
                setTileSource(TileSourceFactory.MAPNIK)
                setMultiTouchControls(true)
            }
        },
        update = { mapView ->
            val geoPoints = points.map { GeoPoint(it.lat, it.lng) }
            mapView.overlays.clear()
            mapView.overlays.add(
                Polyline().apply {
                    setPoints(geoPoints)
                    outlinePaint.color = AndroidColor.parseColor("#34D399") // emerald-400, matches app theme
                    outlinePaint.strokeWidth = 8f
                },
            )
            val bbox = BoundingBox.fromGeoPointsSafe(geoPoints)
            mapView.post { mapView.zoomToBoundingBox(bbox, false, 64) }
            mapView.invalidate()
        },
    )
}
